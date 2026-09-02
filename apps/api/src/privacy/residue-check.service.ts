import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../common/prisma/prisma.service.js";

/**
 * Models allowed to still reference an erased user or workspace (acceptance
 * criterion 1: "no row in any personal-data table references the user/
 * workspace except billing documents and consent tombstones").
 *
 * * `ConsentRecord` — the tombstoned evidence row the DPDP notice-and-choice
 *   record requires; it points at the now-anonymised `users` row on purpose.
 * * `AuditLog` — the append-only administrative trail (THREAT-MODEL T20); an
 *   audit row naming a since-erased actor is the tombstone, not a leak.
 * * Every billing/financial model — invoices are retained 72 months (Rule 46)
 *   and the rest (subscriptions, mandates, payments, credits, commissions,
 *   referrals, payouts) are the financial history behind them; none of them
 *   are erased by `DELETE /me`.
 * * `DsrRequest` itself — the record that the request happened.
 */
const EXEMPT_MODELS: ReadonlySet<string> = new Set([
  "ConsentRecord",
  "AuditLog",
  "DsrRequest",
  "Subscription",
  "Mandate",
  "PassPurchase",
  "Invoice",
  "Payment",
  "BillingEvent",
  "FircRecord",
  "TaxRegistration",
  "CreditAccount",
  "CreditLot",
  "CreditHold",
  "CreditLedger",
  "Commission",
  "Referral",
  "Payout",
  "ReferralReward",
  "AffiliateFyTotal",
  "Affiliate",
  "Coupon",
]);

/** A model with a scalar id-reference field, and how many rows still carry it. */
export interface ResidueHit {
  readonly model: string;
  readonly field: "userId" | "workspaceId";
  readonly count: number;
}

/**
 * Discovers every model with a `userId` or `workspaceId` scalar field from the
 * Prisma DMMF — rather than a hand-maintained list — and counts how many rows
 * still reference a given id. This is what the erasure-sweep contract test
 * (acceptance criterion 1) asserts is empty for every non-exempt model, and
 * what `tools/runbooks/privacy-replay-tombstones.js` calls through
 * `POST /admin/privacy/erasure/replay-tombstones` after a restore, to verify a
 * tombstoned user's data really did come back to zero.
 *
 * Reading the DMMF rather than a fixed table list is deliberate: a work
 * package that adds a `workspaceId` column to a new model is automatically
 * covered by this sweep the next time it runs, with nothing to remember to
 * update here.
 */
@Injectable()
export class ResidueCheckService {
  private readonly fieldsByModel = discoverIdFields();

  /** Every non-exempt model that still has a row for `userId` and/or `workspaceId`. */
  async check(ids: {
    readonly userId?: string;
    readonly workspaceId?: string;
  }): Promise<readonly ResidueHit[]> {
    const hits: ResidueHit[] = [];
    for (const [model, fields] of this.fieldsByModel) {
      if (EXEMPT_MODELS.has(model)) continue;
      const delegate = delegateFor(this.prisma, model);
      if (delegate === undefined) continue;

      if (fields.has("userId") && ids.userId !== undefined) {
        const count = await delegate.count({ where: { userId: ids.userId } });
        if (count > 0) hits.push({ model, field: "userId", count });
      }
      if (fields.has("workspaceId") && ids.workspaceId !== undefined) {
        const count = await delegate.count({ where: { workspaceId: ids.workspaceId } });
        if (count > 0) hits.push({ model, field: "workspaceId", count });
      }
    }
    return hits;
  }

  constructor(private readonly prisma: PrismaService) {}
}

function discoverIdFields(): ReadonlyMap<string, ReadonlySet<string>> {
  const map = new Map<string, Set<string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const fields = new Set<string>();
    for (const field of model.fields) {
      if (field.name === "userId" || field.name === "workspaceId") fields.add(field.name);
    }
    if (fields.size > 0) map.set(model.name, fields);
  }
  return map;
}

/** The `prisma.<modelName lowerCamel>` delegate, or `undefined` if the name is unrecognised. */
function delegateFor(
  prisma: PrismaService,
  modelName: string,
): { count: (args: { where: Record<string, string> }) => Promise<number> } | undefined {
  const key = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const client = prisma as unknown as Record<string, unknown>;
  const delegate = client[key];
  if (
    delegate !== null &&
    typeof delegate === "object" &&
    "count" in delegate &&
    typeof (delegate as { count: unknown }).count === "function"
  ) {
    return delegate as { count: (args: { where: Record<string, string> }) => Promise<number> };
  }
  return undefined;
}
