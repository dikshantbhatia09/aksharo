/**
 * The minimal interface B01's `RenewalService` reads a streak discount
 * through, so `billing/` never depends on `streak/` directly (avoids a
 * circular module import — `streak/` already depends on billing's read model
 * for "is this workspace on a yearly plan").
 *
 * Bound in `app.module.ts` (`{ provide: STREAK_DISCOUNT_PROVIDER, useExisting:
 * StreakDiscountService }`) rather than inside `BillingModule` or
 * `StreakModule`, the same reasoning `CREDITS_FACADE` already uses for the
 * same shape. `RenewalService` injects it with `@Optional()` so billing's own
 * tests (and any environment where `StreakModule` is not wired) keep working
 * with "no discount" rather than a DI failure.
 */
export const STREAK_DISCOUNT_PROVIDER = Symbol("STREAK_DISCOUNT_PROVIDER");

export interface StreakDiscountProvider {
  /**
   * Percent off the next renewal for this workspace (0-100), already
   * clamped to L2/L3's 5%/10% and to `0` for a holdout workspace, a paused
   * workspace, or one with no streak experiment row at all. Never applied
   * above the mandate cap — the cap is the *undiscounted* `listPriceMinor`
   * (`money.ts`'s `quotePrice`), and this percent only ever reduces what is
   * actually charged, exactly as D52 requires.
   */
  getDiscountPercent(workspaceId: string): Promise<number>;
}
