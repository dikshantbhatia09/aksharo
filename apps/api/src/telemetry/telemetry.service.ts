import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { redactConfig, redactText, tailAndRedact } from "@montaj/bridge-core";

import { TelemetryForwarderService } from "./telemetry-forwarder.service.js";
import { MAX_DIAGNOSTICS_BUNDLE_BYTES } from "./telemetry.dto.js";
import { TELEMETRY_CONSENT_ERROR } from "./telemetry.errors.js";
import { AppException, ERROR_CODES, PrismaService } from "../common/index.js";
import {
  DERIVED_STORE,
  supportBundleKey,
  UPLOAD_URL_TTL_SECONDS,
} from "../common/storage/index.js";
import { ConsentsService } from "../consents/consents.service.js";

import type {
  ConfirmDiagnosticsBundleDto,
  PresignDiagnosticsBundleDto,
  SubmitCrashReportDto,
  SubmitTelemetryEventsDto,
} from "./telemetry.dto.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { Prisma } from "@prisma/client";

export interface TelemetryPrincipal {
  readonly userId: string;
  readonly workspaceId: string;
  readonly deviceId?: string;
  readonly kind: string;
}

const LOG_TAIL_LIMIT = 50;
const PROPS_MAX_KEYS = 40;

/**
 * `POST /telemetry/events` and `POST /telemetry/crash` (brief §1-§2).
 *
 * Both are gated on the caller having granted the `telemetry` consent
 * (`ConsentsService`, D61/D62 pattern) — nothing here writes a row for a
 * caller who has not opted in, checked fresh on every call rather than cached,
 * because a withdrawal must take effect on the very next batch, not after a
 * token refresh.
 *
 * Redaction happens again server-side (`packages/bridge-core/src/redact.ts`)
 * even though the client already redacted: the client is not trusted any more
 * than any other request body, and a bug in one client's redaction must not
 * become a bug in what actually reaches storage or a forwarder.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consents: ConsentsService,
    private readonly forwarder: TelemetryForwarderService,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  /** Throws `TELEMETRY_CONSENT_ERROR` when the caller has not granted `telemetry`. */
  async assertConsent(userId: string): Promise<void> {
    const view = await this.consents.current(userId);
    const telemetry = view.purposes.find((p) => p.purpose === "telemetry");
    if (telemetry === undefined || !telemetry.granted) throw TELEMETRY_CONSENT_ERROR;
  }

  async submitEvents(
    principal: TelemetryPrincipal,
    body: SubmitTelemetryEventsDto,
  ): Promise<{ accepted: number }> {
    await this.assertConsent(principal.userId);

    let accepted = 0;
    for (const event of body.events) {
      const redactedProps = redactCappedProps(event.props);
      try {
        await this.prisma.productEvent.create({
          data: {
            id: ulid(),
            kind: event.kind,
            workspaceId: principal.workspaceId,
            userId: principal.userId,
            props: {
              ...redactedProps,
              clientEventId: event.eventId,
              clientAt: event.at,
              appVersion: event.appVersion,
              deviceId: principal.deviceId ?? null,
              clientKind: principal.kind,
            } as Prisma.InputJsonValue,
          },
        });
        accepted += 1;
      } catch (error) {
        // Same "never fail, never block" contract as `ProductEventsService`.
        this.logger.warn({ error, kind: event.kind }, "failed to record telemetry event");
      }

      void this.forwarder.forwardEvent({
        kind: event.kind,
        distinctId: principal.userId,
        props: redactedProps,
        at: event.at,
      });
    }
    return { accepted };
  }

  async submitCrash(
    principal: TelemetryPrincipal,
    body: SubmitCrashReportDto,
  ): Promise<{ crashReportId: string }> {
    await this.assertConsent(principal.userId);

    const crashReportId = ulid();
    const stack = redactText(body.stack);
    const logTail = tailAndRedact(body.logTail, LOG_TAIL_LIMIT);

    await this.prisma.crashReport.create({
      data: {
        id: crashReportId,
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        deviceId: principal.deviceId ?? null,
        clientKind: body.clientKind,
        appVersion: body.appVersion,
        osVersion: body.osVersion,
        stack,
        logTail,
      },
    });

    void this.forwarder
      .forwardCrash({
        crashReportId,
        clientKind: body.clientKind,
        appVersion: body.appVersion,
        osVersion: body.osVersion,
        stack,
      })
      .then(() =>
        this.prisma.crashReport.update({
          where: { id: crashReportId },
          data: { forwardedAt: new Date() },
        }),
      )
      .catch((error: unknown) => {
        this.logger.warn({ error, crashReportId }, "crash forward bookkeeping failed");
      });

    return { crashReportId };
  }

  /**
   * Diagnostics bundle attach, step 1: a presigned PUT for the zip a user
   * explicitly built (redacted logs, config without secrets, versions, the
   * bridge discovery file minus the bearer — brief §1/§3), scoped to one
   * support ticket this caller owns. Like every other binary upload in this
   * API, the bytes go straight to R2 — never through this process — so
   * `confirm` (step 2) is what actually links the key to the ticket, after
   * checking the object landed and is within the size cap.
   */
  async presignDiagnosticsBundle(
    principal: TelemetryPrincipal,
    body: PresignDiagnosticsBundleDto,
  ): Promise<{ uploadUrl: string; bundleKey: string; maxBytes: number }> {
    await this.assertConsent(principal.userId);
    await this.ownedTicket(principal, body.ticketId);

    const bundleKey = supportBundleKey(principal.workspaceId, body.ticketId);
    const uploadUrl = await this.derived.presignPut(
      bundleKey,
      UPLOAD_URL_TTL_SECONDS,
      "application/zip",
    );
    return { uploadUrl, bundleKey, maxBytes: MAX_DIAGNOSTICS_BUNDLE_BYTES };
  }

  /**
   * Step 2: after the client PUTs the zip, this confirms the object actually
   * landed and is within the 10 MB cap, then writes `bundleKey` onto the
   * ticket's existing `diagnostics` JSON column — the same column B12 already
   * fills with the small consent-gated diagnostics object.
   * `SupportService`/`SupportController` (B12, outside this WP's file
   * boundary) are not touched; the write goes straight through Prisma against
   * the same `support_tickets` row.
   */
  async confirmDiagnosticsBundle(
    principal: TelemetryPrincipal,
    body: ConfirmDiagnosticsBundleDto,
  ): Promise<{ bundleKey: string }> {
    await this.assertConsent(principal.userId);
    const ticket = await this.ownedTicket(principal, body.ticketId);

    const bundleKey = supportBundleKey(principal.workspaceId, body.ticketId);
    const head = await this.derived.head(bundleKey);
    if (head === null || head.sizeBytes === 0 || head.sizeBytes > MAX_DIAGNOSTICS_BUNDLE_BYTES) {
      throw new AppException(
        ERROR_CODES.payloadTooLarge,
        `Diagnostics bundle must be between 1 byte and ${String(MAX_DIAGNOSTICS_BUNDLE_BYTES)} bytes.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const existingDiagnostics =
      ticket.diagnostics !== null && typeof ticket.diagnostics === "object"
        ? (ticket.diagnostics as Record<string, unknown>)
        : {};
    await this.prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { diagnostics: { ...existingDiagnostics, bundleKey } as Prisma.InputJsonValue },
    });

    return { bundleKey };
  }

  private async ownedTicket(
    principal: TelemetryPrincipal,
    ticketId: string,
  ): Promise<{ id: string; workspaceId: string; userId: string; diagnostics: unknown }> {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, workspaceId: true, userId: true, diagnostics: true },
    });
    if (
      ticket === null ||
      ticket.workspaceId !== principal.workspaceId ||
      ticket.userId !== principal.userId
    ) {
      throw new AppException(
        ERROR_CODES.notFound,
        "Support ticket not found.",
        HttpStatus.NOT_FOUND,
      );
    }
    return ticket;
  }
}

/** Redacts every string value and caps the number of keys a client can send. */
function redactCappedProps(props: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(props).slice(0, PROPS_MAX_KEYS);
  const capped: Record<string, unknown> = {};
  for (const [key, value] of entries) capped[key] = value;
  return redactConfig(capped) as Record<string, unknown>;
}
