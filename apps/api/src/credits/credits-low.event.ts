/**
 * Event name and payload `CreditsLowBalanceNotifier.checkThreshold()` emits
 * right where it already raises the `low-credits` notification (B14b:
 * "credits.low where B02b raises the low-credits notification"), the same
 * `EventEmitter2` precedent as `referrals/export-completed.event.ts`.
 */
export const CREDITS_LOW_EVENT = "credits.low";

export interface CreditsLowPayload {
  readonly workspaceId: string;
  readonly thresholdFraction: number;
  readonly balanceTenths: number;
}
