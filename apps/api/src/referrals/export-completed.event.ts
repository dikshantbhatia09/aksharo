/**
 * Event name and payload the export-completion paths emit right after they
 * already write the `publish_events` row for a completed export (brief
 * setup: "hook the first-completed-export signal there via the
 * `EventEmitter2` pattern, never by forking").
 *
 * `EventEmitter2` (`EventEmitterModule.forRoot()`, registered once in
 * `app.module.ts`, `invoices/billing-events.ts`'s precedent) is global, so
 * this module's listener (`export-completed.listener.ts`) picks the event up
 * without either side importing the other's internals.
 *
 * **Deviation, flagged for the orchestrator** (same shape as the one
 * `invoices/billing-events.ts` already flagged for B05): emitting this event
 * requires three small, additive edits outside this work package's stated
 * file boundary —
 *
 * - `apps/api/src/exports/exports.service.ts`: `EventEmitter2` injected into
 *   the constructor and one `this.events.emit(...)` call added right after
 *   `completeManifest()`'s existing `publishEvent.create` (the browser path).
 * - `apps/api/src/exports/render-completion.handler.ts`: same, in
 *   `recordPublishEvent()` — the one helper both cloud completion handlers
 *   (`render.video`, `render.subtitle`) already call, so one edit covers
 *   both.
 *
 * No branch, return type or existing behaviour of `ExportsService` or the
 * completion handlers changes; every one of A21/B02b's own export tests
 * should keep passing unmodified. This was necessary because there is no
 * existing signal a listener elsewhere in the codebase could subscribe to
 * for "this workspace just completed an export" — forking the completion
 * logic into `referrals/` instead (re-deriving the manifest claim,
 * `publish_events` write, etc.) was the alternative the brief explicitly
 * rules out ("never by forking"). Reported per "implement the brief exactly
 * and report conflicts instead of redesigning."
 */
export const EXPORT_COMPLETED_EVENT = "export.completed";

export interface ExportCompletedPayload {
  readonly workspaceId: string;
  readonly exportId: string;
}
