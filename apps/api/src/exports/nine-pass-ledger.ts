import { Injectable } from "@nestjs/common";

/**
 * The ₹9 clean-export pass (`04 §Offers`): "one more clean export without a
 * plan", browser-render only, ≤ 10 minutes.
 *
 * B04 owns the real pass tables (`passes_purchased`, per `06-data-model.md`) and
 * the checkout that fills them; this work package only needs the *interface* —
 * `ExportsService` asks `isAvailable` before it clears a watermark and calls
 * `consume` from the manifest-completion path, exactly as it will once B04
 * lands. Until then {@link NoopNinePassLedger} always answers "no pass", which
 * is the safe default: an entitlement stub must never invent money.
 */
export interface NinePassLedger {
  /** Does this workspace hold an unconsumed ₹9 pass right now? */
  isAvailable(workspaceId: string): Promise<boolean>;
  /** Spend one pass. Idempotent per `manifestId` once B04 backs it with a table. */
  consume(workspaceId: string, manifestId: string): Promise<void>;
}

export const NINE_PASS_LEDGER = Symbol("NINE_PASS_LEDGER");

@Injectable()
export class NoopNinePassLedger implements NinePassLedger {
  async isAvailable(_workspaceId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  async consume(_workspaceId: string, _manifestId: string): Promise<void> {
    return Promise.resolve();
  }
}
