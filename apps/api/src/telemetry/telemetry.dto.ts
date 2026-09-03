import { z } from "zod";

import { zodDto } from "../common/index.js";

/**
 * Product-events vocabulary this endpoint accepts, reusing B17's
 * (`product_events.kind`) naming style rather than inventing a second one.
 * Closed set: an unknown kind is a client bug, not a new metric to silently
 * accept, so the schema rejects it rather than widening `props`.
 */
export const TELEMETRY_EVENT_KINDS = [
  "app_launched",
  "app_quit",
  "app_crashed",
  "consent_granted",
  "consent_withdrawn",
  "project_opened",
  "export_started",
  "export_completed",
  "bridge_paired",
  "bridge_connected",
  "bridge_disconnected",
  "diagnostics_bundle_created",
  "diagnostics_bundle_attached",
  "update_check",
  "update_installed",
] as const;

export const telemetryEventKindSchema = z.enum(TELEMETRY_EVENT_KINDS);

/** One event, already redacted client-side (server redaction is a second pass). */
export const telemetryEventSchema = z.object({
  /** Client ULID; de-duplicates a batch retried after a network blip. */
  eventId: z.string().length(26),
  kind: telemetryEventKindSchema,
  at: z.string().datetime(),
  /** App/bridge version, e.g. `1.4.0`. */
  appVersion: z.string().max(32),
  /** Free-form but capped and redacted server-side too; never PII by design. */
  props: z.record(z.string(), z.unknown()).default({}),
});
export type TelemetryEventInput = z.infer<typeof telemetryEventSchema>;

/** A batch: the desktop/bridge client's offline queue flushes several at once. */
export const submitTelemetryEventsSchema = z.object({
  events: z.array(telemetryEventSchema).min(1).max(100),
});
export class SubmitTelemetryEventsDto extends zodDto(submitTelemetryEventsSchema) {}

export const submitTelemetryEventsResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});
export type SubmitTelemetryEventsResponse = z.infer<typeof submitTelemetryEventsResponseSchema>;

export const CRASH_CLIENT_KINDS = ["desktop", "bridge", "premiere", "ae", "resolve"] as const;

/**
 * Minidump-free by design (brief ruling): stack + app/OS version + a redacted
 * log tail, capped at 50 lines server-side regardless of what the client sent
 * — the client's own ring buffer already caps it, this is the ceiling that
 * does not trust the client to have done so.
 */
export const submitCrashReportSchema = z.object({
  clientKind: z.enum(CRASH_CLIENT_KINDS),
  appVersion: z.string().max(32),
  osVersion: z.string().max(120),
  stack: z.string().max(20_000),
  logTail: z.array(z.string().max(2_000)).max(50).default([]),
});
export class SubmitCrashReportDto extends zodDto(submitCrashReportSchema) {}

export const submitCrashReportResponseSchema = z.object({
  crashReportId: z.string(),
});
export type SubmitCrashReportResponse = z.infer<typeof submitCrashReportResponseSchema>;

/**
 * The diagnostics bundle a user explicitly builds and attaches to a support
 * ticket (brief §1/§3): a zip of redacted logs, config without secrets,
 * versions and the bridge discovery file minus the bearer. Presigned-PUT,
 * like every other binary upload in this API (media, exports, fonts) — the
 * bytes go straight to R2, never through this process, so there is no reason
 * to raise the JSON body-size limit for one route. 10 MB is the brief's cap;
 * `confirm` re-checks the object's actual size against it before the ticket
 * is allowed to reference the key, since a presigned PUT's size is the
 * client's promise, not a server-enforced fact.
 */
export const MAX_DIAGNOSTICS_BUNDLE_BYTES = 10 * 1024 * 1024;

export const presignDiagnosticsBundleSchema = z.object({
  ticketId: z.string().length(26),
});
export class PresignDiagnosticsBundleDto extends zodDto(presignDiagnosticsBundleSchema) {}

export const presignDiagnosticsBundleResponseSchema = z.object({
  uploadUrl: z.string(),
  bundleKey: z.string(),
  maxBytes: z.number().int().positive(),
});
export type PresignDiagnosticsBundleResponse = z.infer<
  typeof presignDiagnosticsBundleResponseSchema
>;

export const confirmDiagnosticsBundleSchema = z.object({
  ticketId: z.string().length(26),
});
export class ConfirmDiagnosticsBundleDto extends zodDto(confirmDiagnosticsBundleSchema) {}

export const confirmDiagnosticsBundleResponseSchema = z.object({
  bundleKey: z.string(),
});
export type ConfirmDiagnosticsBundleResponse = z.infer<
  typeof confirmDiagnosticsBundleResponseSchema
>;
