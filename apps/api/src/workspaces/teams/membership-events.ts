/**
 * Event name and payload `workspaces/members.service.ts` emits at the two
 * points where the count of active, seat-billed memberships changes: an
 * invitation is accepted, or a member is removed (brief §1: "seat count →
 * B01 subscription quantity with proration").
 *
 * Same pattern as `invoices/billing-events.ts` (B05): `MembersService`
 * (A05's file, outside this work package's file boundary) emits with
 * `EventEmitter2` right after each existing transition commits — no branch of
 * `accept`/`remove` is duplicated or forked, only observed. This module owns
 * the event *contract* so `MembersService` and this work package's own
 * `SeatBillingListener` agree on it without either importing the other's
 * internals.
 *
 * **Deviation, flagged for the orchestrator:** emitting this event requires
 * two small, additive edits outside the brief's stated file boundary
 * (`apps/api/src/workspaces/members.service.ts` remains A05's file) —
 * `EventEmitter2` injected into the constructor and one `this.events.emit(...)`
 * call added after `accept()`'s and `remove()`'s existing "processed" points.
 * No branch, return type or existing behaviour changes; A05's own membership
 * tests should keep passing unmodified. Necessary because seat billing cannot
 * react to a membership change without something in `workspaces/` emitting it,
 * exactly the justification B05 gave for the equivalent billing-events edit.
 */
export const MEMBERSHIP_SEAT_EVENTS = {
  seatsChanged: "workspaces.membership.seats_changed",
} as const;

export interface SeatsChangedEvent {
  readonly workspaceId: string;
  /** Why the count changed, for the listener's audit row. */
  readonly reason: "invite_accepted" | "member_removed";
}
