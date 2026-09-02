import { Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../common/prisma/prisma.service.js";

import type { NinePassLedger } from "../exports/nine-pass-ledger.js";

/**
 * The real `NinePassLedger` (`exports/nine-pass-ledger.ts`'s interface),
 * backed by `passes_purchased`. Replaces A21's `NoopNinePassLedger` in
 * `ExportsModule` (wired in `offers.module.ts`).
 *
 * A pass is "available" once `billing/webhooks.service.ts#grantPass` has
 * stamped `consumedAt` (paid) and stays available until this ledger's own
 * {@link consume} stamps `redeemedAt` (spent on a manifest) — the two fields
 * this work package's migration added specifically so "paid" and "spent"
 * cannot collide (see the schema comment on `PassPurchase`).
 */
@Injectable()
export class PassesNinePassLedger implements NinePassLedger {
  private readonly logger = new Logger(PassesNinePassLedger.name);

  constructor(private readonly prisma: PrismaService) {}

  async isAvailable(workspaceId: string): Promise<boolean> {
    const pass = await this.prisma.passPurchase.findFirst({
      where: { workspaceId, kind: "first_export", consumedAt: { not: null }, redeemedAt: null },
      select: { id: true },
    });
    return pass !== null;
  }

  /**
   * Spends the oldest unredeemed, paid `first_export` pass on `manifestId`.
   *
   * Idempotent per `manifestId`: if this exact manifest already redeemed a pass
   * (a retried completion after the handler's own work threw further down the
   * line — `exports.service.ts#completeManifest` claims the manifest's nonce
   * first, so a genuine replay never reaches here, but a partial failure between
   * the nonce claim and this call is exactly the case `render-completion
   * .handler.ts`'s own doc comment calls out), this is a no-op rather than a
   * second spend. Never throws: a stale or already-spent state here must not
   * fail a browser export whose watermark decision was already made and signed.
   */
  async consume(workspaceId: string, manifestId: string): Promise<void> {
    const alreadyRedeemed = await this.prisma.passPurchase.findFirst({
      where: { workspaceId, kind: "first_export", redeemedManifestId: manifestId },
      select: { id: true },
    });
    if (alreadyRedeemed !== null) return;

    const candidate = await this.prisma.passPurchase.findFirst({
      where: { workspaceId, kind: "first_export", consumedAt: { not: null }, redeemedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (candidate === null) {
      this.logger.warn(
        { workspaceId, manifestId },
        "nine-pass consume() called with no available pass — the decision was made against a stale isAvailable() read",
      );
      return;
    }

    // `redeemedAt: null` in the `where` makes this a compare-and-swap: a
    // concurrent `consume` for a different manifest can win the race, but never
    // both — the loser's `updateMany` touches zero rows and is retried by the
    // fallback lookup on the next completion, exactly as a lost-race browser
    // export retries the whole `POST /projects/{id}/exports` call.
    await this.prisma.passPurchase.updateMany({
      where: { id: candidate.id, redeemedAt: null },
      data: { redeemedAt: new Date(), redeemedManifestId: manifestId },
    });
  }
}
