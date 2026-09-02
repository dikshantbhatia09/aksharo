import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { TELEMETRY_RATE_LIMITS } from "./telemetry.constants.js";
import {
  confirmDiagnosticsBundleResponseSchema,
  confirmDiagnosticsBundleSchema,
  presignDiagnosticsBundleResponseSchema,
  presignDiagnosticsBundleSchema,
  submitCrashReportResponseSchema,
  submitCrashReportSchema,
  submitTelemetryEventsResponseSchema,
  submitTelemetryEventsSchema,
  ConfirmDiagnosticsBundleDto,
  PresignDiagnosticsBundleDto,
  SubmitCrashReportDto,
  SubmitTelemetryEventsDto,
} from "./telemetry.dto.js";
import { TelemetryService } from "./telemetry.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  AllowBridgeToken,
  CurrentUser,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type {
  ConfirmDiagnosticsBundleResponse,
  PresignDiagnosticsBundleResponse,
  SubmitCrashReportResponse,
  SubmitTelemetryEventsResponse,
} from "./telemetry.dto.js";
import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/telemetry` (C12 brief §1): consent-gated product events and crash reports
 * from the desktop shell and the local bridge. Never reachable without a
 * bearer token, and `@AllowBridgeToken()` lets a `kind:"bridge"` device token
 * through too (B08b) — the local bridge process has no user sitting at a
 * browser to hold a `web`/`desktop` token, but it still needs to report its
 * own crashes and lifecycle events under the same per-device consent.
 */
@ApiTags("telemetry")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`telemetry/consent_required`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard, RateLimitGuard)
@Controller("telemetry")
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Post("events")
  @AllowBridgeToken()
  @RateLimit(TELEMETRY_RATE_LIMITS.events)
  @ApiOperation({
    summary: "Submit a batch of consent-gated telemetry events",
    description:
      "Batched so the offline queue can flush several at once; rejected with " +
      "`telemetry/consent_required` unless the caller has granted the `telemetry` consent.",
    operationId: "submitTelemetryEvents",
  })
  @ApiBody(zodBody(submitTelemetryEventsSchema))
  @ApiOkResponse(zodResponse(submitTelemetryEventsResponseSchema, "Count accepted."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async events(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SubmitTelemetryEventsDto,
  ): Promise<SubmitTelemetryEventsResponse> {
    return this.telemetry.submitEvents(
      {
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        kind: principal.kind,
        ...(principal.deviceId !== undefined ? { deviceId: principal.deviceId } : {}),
      },
      body,
    );
  }

  @Post("crash")
  @AllowBridgeToken()
  @RateLimit(TELEMETRY_RATE_LIMITS.crash)
  @ApiOperation({
    summary: "Submit a redacted crash report",
    description:
      "Minidump-free by default: a redacted stack trace, app/OS version and the " +
      "last 50 (already redacted) log lines. Forwarded to Sentry server-side only " +
      "when `SENTRY_DSN` is configured.",
    operationId: "submitCrashReport",
  })
  @ApiBody(zodBody(submitCrashReportSchema))
  @ApiOkResponse(zodResponse(submitCrashReportResponseSchema, "The stored crash report's id."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async crash(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: SubmitCrashReportDto,
  ): Promise<SubmitCrashReportResponse> {
    return this.telemetry.submitCrash(
      {
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        kind: principal.kind,
        ...(principal.deviceId !== undefined ? { deviceId: principal.deviceId } : {}),
      },
      body,
    );
  }

  @Post("diagnostics-bundle/presign")
  @RateLimit(TELEMETRY_RATE_LIMITS.diagnosticsBundle)
  @ApiOperation({
    summary: "Presign an upload for a diagnostics bundle on the caller's own support ticket",
    description:
      "Stored at `ws/{workspaceId}/support/{ticketId}/diagnostics.zip` (R2) once uploaded and " +
      "confirmed via `POST /telemetry/diagnostics-bundle/confirm`; capped at 10 MB.",
    operationId: "presignDiagnosticsBundle",
  })
  @ApiBody(zodBody(presignDiagnosticsBundleSchema))
  @ApiOkResponse(zodResponse(presignDiagnosticsBundleResponseSchema, "The presigned PUT URL."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async presignDiagnosticsBundle(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: PresignDiagnosticsBundleDto,
  ): Promise<PresignDiagnosticsBundleResponse> {
    return this.telemetry.presignDiagnosticsBundle(
      {
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        kind: principal.kind,
        ...(principal.deviceId !== undefined ? { deviceId: principal.deviceId } : {}),
      },
      body,
    );
  }

  @Post("diagnostics-bundle/confirm")
  @RateLimit(TELEMETRY_RATE_LIMITS.diagnosticsBundle)
  @ApiOperation({
    summary: "Confirm an uploaded diagnostics bundle and attach it to the ticket",
    operationId: "confirmDiagnosticsBundle",
  })
  @ApiBody(zodBody(confirmDiagnosticsBundleSchema))
  @ApiOkResponse(zodResponse(confirmDiagnosticsBundleResponseSchema, "The attached bundle's key."))
  @ApiTooManyRequestsResponse({ description: "`common/rate_limited`." })
  async confirmDiagnosticsBundle(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: ConfirmDiagnosticsBundleDto,
  ): Promise<ConfirmDiagnosticsBundleResponse> {
    return this.telemetry.confirmDiagnosticsBundle(
      {
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        kind: principal.kind,
        ...(principal.deviceId !== undefined ? { deviceId: principal.deviceId } : {}),
      },
      body,
    );
  }
}
