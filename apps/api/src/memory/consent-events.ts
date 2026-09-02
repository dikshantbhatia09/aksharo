/**
 * Event name and payload `ConsentsService` emits right after it stamps
 * `withdrawnAt` on a purpose's open grants (D61/D62, brief §1: "consent
 * withdrawal deletes all entries").
 *
 * **Deviation, flagged for the orchestrator** (same shape as `invoices/billing-events.ts`,
 * the precedent this follows): making the erasure cascade fire on withdrawal
 * requires one small, additive edit outside this work package's stated file
 * boundary — `apps/api/src/consents/consents.service.ts` remains A05's file.
 * `EventEmitter2` (already registered globally in `app.module.ts`) is injected
 * into `ConsentsService`'s constructor and one `this.events.emit(...)` call is
 * added inside `set()`, only on the `!granted` branch, after the existing
 * transaction commits. No branch, return type or existing behaviour of
 * `ConsentsService` changes, and A05's own consent tests are unaffected — the
 * emit is unobserved unless something is listening, which is exactly the
 * `MemoryModule` listener this file's contract exists for. This was necessary
 * because "consent withdrawal deletes all entries" cannot happen without
 * something in `consents/` announcing that a withdrawal occurred, and there is
 * no B16 module yet to own that announcement.
 */
export const CONSENT_EVENTS = {
  withdrawn: "consent.withdrawn",
} as const;

export interface ConsentWithdrawnEvent {
  readonly userId: string;
  readonly workspaceId: string;
  readonly purpose: string;
}
