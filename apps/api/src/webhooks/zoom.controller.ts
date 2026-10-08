import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import crypto from "node:crypto";
import type { Request } from "express";

import { PrismaService } from "../common/index.js";
import { ZoomIngestService } from "../integrations/zoom-ingest.service.js";
import { ZoomService } from "../integrations/zoom.service.js";
import type { ZoomWebhookPayload } from "../integrations/zoom.dto.js";

export function verifyZoomSignature(options: {
  readonly signatureHeader?: string;
  readonly timestampHeader?: string;
  readonly bodyText: string;
  readonly secretToken: string;
}): boolean {
  const { signatureHeader, timestampHeader, bodyText, secretToken } = options;
  if (!signatureHeader || !timestampHeader || !secretToken) {
    return false;
  }

  // Prevent replay attacks (5 minute freshness window)
  const now = Math.floor(Date.now() / 1000);
  const reqTime = Number(timestampHeader);
  if (Math.abs(now - reqTime) > 300) {
    return false;
  }

  const message = `v0:${timestampHeader}:${bodyText}`;
  const computedHash = crypto.createHmac("sha256", secretToken).update(message).digest("hex");
  const expectedSignature = `v0=${computedHash}`;

  if (signatureHeader.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader, "utf8"),
    Buffer.from(expectedSignature, "utf8"),
  );
}

@ApiTags("webhooks")
@Controller()
export class ZoomWebhookController {
  private readonly logger = new Logger(ZoomWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zoomService: ZoomService,
    private readonly zoomIngest: ZoomIngestService,
  ) {}

  @Post("webhooks/zoom")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Handle Zoom Webhooks and endpoint URL validation",
    description:
      "Validates Zoom HMAC-SHA256 CRC challenges and receives recording.completed events for automatic repurposing.",
    operationId: "handleZoomWebhook",
  })
  @ApiResponse({ status: 200, description: "Webhook acknowledged or CRC challenge answered." })
  async handleZoomWebhook(
    @Body() body: ZoomWebhookPayload,
    @Headers("x-zm-signature") signature?: string,
    @Headers("x-zm-request-timestamp") timestamp?: string,
    @Req() req?: Request,
  ): Promise<Record<string, unknown>> {
    const secretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || "";

    // 1. Zoom CRC URL Validation challenge
    if (body.event === "endpoint.url_validation" && body.payload?.plainToken) {
      const plainToken = body.payload.plainToken;
      const hash = crypto
        .createHmac("sha256", secretToken || "mock_secret")
        .update(plainToken)
        .digest("hex");

      return {
        plainToken,
        encryptedToken: hash,
      };
    }

    // 2. Verify Zoom HMAC-SHA256 signature when secretToken is configured
    if (secretToken && signature && timestamp) {
      const rawBodyText =
        (req as any)?.rawBody?.toString("utf8") || JSON.stringify(body);
      const isValid = verifyZoomSignature({
        signatureHeader: signature,
        timestampHeader: timestamp,
        bodyText: rawBodyText,
        secretToken,
      });

      if (!isValid) {
        this.logger.warn("Invalid Zoom webhook signature received");
        throw new UnauthorizedException("Invalid Zoom webhook signature");
      }
    }

    // 3. Process Zoom recording.completed event
    if (body.event === "recording.completed" && body.payload?.object) {
      const obj = body.payload.object;
      const meetingId = String(obj.id);
      const topic = obj.topic || `Zoom Recording - ${meetingId}`;
      const durationMin = Number(obj.duration) || 0;
      const hostId = obj.host_id || "";
      const recordingFiles = obj.recording_files || [];

      // Persistent Idempotent Webhook Ledger: check for duplicates
      const existing = await this.prisma.zoomRecordingEvent.findUnique({
        where: { meetingId },
      });

      if (existing) {
        this.logger.log(`Ignoring duplicate Zoom webhook for meeting ${meetingId}`);
        return {
          status: "duplicate",
          meetingId,
          ledgerStatus: existing.status,
        };
      }

      // Find workspace integration matching host ID
      const integration = await this.prisma.workspaceZoomIntegration.findFirst({
        where: { zoomUserId: hostId },
      });

      if (!integration) {
        // Record as IGNORED in persistent ledger
        await this.prisma.zoomRecordingEvent.create({
          data: {
            meetingId,
            topic,
            durationMin,
            fileCount: recordingFiles.length,
            status: "IGNORED",
          },
        });
        return {
          status: "ignored",
          meetingId,
          reason: "no_matching_workspace_integration",
        };
      }

      const workspaceId = integration.workspaceId;

      // Check selective ingestion rules
      // 1. autoRepurpose toggle
      if (!integration.autoRepurpose) {
        await this.prisma.zoomRecordingEvent.create({
          data: {
            meetingId,
            workspaceId,
            topic,
            durationMin,
            fileCount: recordingFiles.length,
            status: "IGNORED",
          },
        });
        return {
          status: "ignored",
          meetingId,
          reason: "auto_repurpose_disabled",
        };
      }

      // 2. minDurationSec check (durationMin in minutes * 60)
      const durationSec = durationMin * 60;
      if (durationSec < integration.minDurationSec) {
        await this.prisma.zoomRecordingEvent.create({
          data: {
            meetingId,
            workspaceId,
            topic,
            durationMin,
            fileCount: recordingFiles.length,
            status: "IGNORED",
          },
        });
        return {
          status: "ignored",
          meetingId,
          reason: `duration_below_minimum_${integration.minDurationSec}s`,
        };
      }

      // 3. nameFilter check (tag / regex filter)
      if (integration.nameFilter && integration.nameFilter.trim().length > 0) {
        try {
          const filterRegex = new RegExp(integration.nameFilter.trim(), "i");
          if (!filterRegex.test(topic)) {
            await this.prisma.zoomRecordingEvent.create({
              data: {
                meetingId,
                workspaceId,
                topic,
                durationMin,
                fileCount: recordingFiles.length,
                status: "IGNORED",
              },
            });
            return {
              status: "ignored",
              meetingId,
              reason: "name_filter_not_matched",
            };
          }
        } catch {
          // If regex invalid, fallback to case-insensitive substring
          if (!topic.toLowerCase().includes(integration.nameFilter.toLowerCase())) {
            await this.prisma.zoomRecordingEvent.create({
              data: {
                meetingId,
                workspaceId,
                topic,
                durationMin,
                fileCount: recordingFiles.length,
                status: "IGNORED",
              },
            });
            return {
              status: "ignored",
              meetingId,
              reason: "name_filter_not_matched",
            };
          }
        }
      }

      // Passed all selective rules: record as PROCESSING in persistent ledger
      await this.prisma.zoomRecordingEvent.create({
        data: {
          meetingId,
          workspaceId,
          topic,
          durationMin,
          fileCount: recordingFiles.length,
          status: "PROCESSING",
        },
      });

      // Initiation SLA: download initiation dispatched asynchronously
      setImmediate(async () => {
        try {
          const validAccessToken = await this.zoomService.getValidAccessToken(workspaceId);
          await this.zoomIngest.ingestZoomRecording({
            workspaceId,
            meetingId,
            topic,
            durationMin,
            recordingFiles,
            accessToken: validAccessToken,
          });
        } catch (err) {
          this.logger.error(`Error ingesting Zoom recording for meeting ${meetingId}`, err);
          await this.prisma.zoomRecordingEvent.updateMany({
            where: { meetingId },
            data: {
              status: "FAILED",
              updatedAt: new Date(),
            },
          });
        }
      });

      // Immediate acknowledgment within 200ms SLA
      return {
        status: "accepted",
        meetingId,
        workspaceId,
        durationMin,
      };
    }

    return {
      status: "acknowledged",
      event: body.event,
    };
  }
}

