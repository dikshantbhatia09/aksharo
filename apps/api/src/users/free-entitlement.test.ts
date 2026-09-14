import { describe, expect, it } from "vitest";

import { MissingFreePlanError, provisionFreeEntitlement } from "./free-entitlement.js";

import type { PrismaTransaction } from "../common/prisma/prisma.service.js";

const PLAN_ID = "01JPLANFREE00000000000000";
const WORKSPACE_ID = "01JWORKSPACE0000000000000A";
const AT = new Date("2026-09-14T10:00:00.000Z");

interface Row {
  readonly [key: string]: unknown;
}

/**
 * The narrow slice of a Prisma transaction this module touches, recorded rather
 * than executed. A real database is not the subject here — the invariant is:
 * which rows get written, with which totals, and whether a second call writes
 * anything at all.
 */
function fakeTx(options: { plan?: { id: string; creditsPerMonthTenths: number } | null } = {}): {
  tx: PrismaTransaction;
  written: { accounts: Row[]; lots: Row[]; ledger: Row[]; subscriptions: Row[] };
} {
  const plan =
    options.plan === undefined ? { id: PLAN_ID, creditsPerMonthTenths: 200 } : options.plan;
  const written = {
    accounts: [] as Row[],
    lots: [] as Row[],
    ledger: [] as Row[],
    subscriptions: [] as Row[],
  };

  const tx = {
    plan: {
      findUnique: () => Promise.resolve(plan),
    },
    creditAccount: {
      findUnique: ({ where }: { where: { workspaceId: string } }) =>
        Promise.resolve(
          written.accounts.find((row) => row["workspaceId"] === where.workspaceId) ?? null,
        ),
      create: ({ data }: { data: Row }) => {
        written.accounts.push(data);
        return Promise.resolve(data);
      },
    },
    creditLot: {
      create: ({ data }: { data: Row }) => {
        written.lots.push(data);
        return Promise.resolve(data);
      },
    },
    creditLedger: {
      create: ({ data }: { data: Row }) => {
        written.ledger.push(data);
        return Promise.resolve(data);
      },
    },
    subscription: {
      create: ({ data }: { data: Row }) => {
        written.subscriptions.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as PrismaTransaction;

  return { tx, written };
}

describe("provisionFreeEntitlement", () => {
  it("writes the subscription, account, lot and ledger row a new workspace needs", async () => {
    const { tx, written } = fakeTx();

    const outcome = await provisionFreeEntitlement(tx, {
      workspaceId: WORKSPACE_ID,
      currency: "INR",
      at: AT,
    });

    expect(outcome).toEqual({ status: "provisioned", grantedTenths: 200 });
    expect(written.accounts).toHaveLength(1);
    expect(written.lots).toHaveLength(1);
    expect(written.ledger).toHaveLength(1);
    expect(written.subscriptions).toHaveLength(1);
  });

  it("leaves the ledger invariant intact: balance = lot remainders = ledger deltas", async () => {
    const { tx, written } = fakeTx();
    await provisionFreeEntitlement(tx, { workspaceId: WORKSPACE_ID, currency: "INR", at: AT });

    const lotRemainder = written.lots.reduce(
      (total, lot) => total + Number(lot["remainingTenths"]),
      0,
    );
    const ledgerDelta = written.ledger.reduce((total, row) => total + Number(row["deltaTenths"]), 0);

    expect(written.accounts[0]?.["balanceTenths"]).toBe(200);
    expect(lotRemainder).toBe(200);
    expect(ledgerDelta).toBe(200);
    expect(written.ledger[0]?.["balanceAfterTenths"]).toBe(200);
  });

  it("dates the grant and the first billing period one month out", async () => {
    const { tx, written } = fakeTx();
    await provisionFreeEntitlement(tx, { workspaceId: WORKSPACE_ID, currency: "INR", at: AT });

    const periodEnd = new Date("2026-10-14T10:00:00.000Z");
    // The monthly anniversary tick finds the account through `grantResetAt`, so
    // the second month's grant needs no separate wiring.
    expect(written.accounts[0]?.["grantResetAt"]).toEqual(periodEnd);
    expect(written.lots[0]?.["expiresAt"]).toEqual(periodEnd);
    expect(written.subscriptions[0]?.["currentPeriodStart"]).toEqual(AT);
    expect(written.subscriptions[0]?.["currentPeriodEnd"]).toEqual(periodEnd);
  });

  it("carries the workspace currency onto the subscription", async () => {
    const { tx, written } = fakeTx();
    await provisionFreeEntitlement(tx, { workspaceId: WORKSPACE_ID, currency: "USD", at: AT });
    expect(written.subscriptions[0]?.["currency"]).toBe("USD");
    expect(written.subscriptions[0]?.["provider"]).toBe("none");
    expect(written.subscriptions[0]?.["listPriceMinor"]).toBe(0);
  });

  it("grants once: a retry finds the account and writes nothing further", async () => {
    const { tx, written } = fakeTx();
    await provisionFreeEntitlement(tx, { workspaceId: WORKSPACE_ID, currency: "INR", at: AT });
    const second = await provisionFreeEntitlement(tx, {
      workspaceId: WORKSPACE_ID,
      currency: "INR",
      at: AT,
    });

    expect(second).toEqual({ status: "already_provisioned", grantedTenths: 200 });
    expect(written.lots).toHaveLength(1);
    expect(written.ledger).toHaveLength(1);
    expect(written.subscriptions).toHaveLength(1);
  });

  it("still creates the entitlement rows for a plan that grants nothing", async () => {
    const { tx, written } = fakeTx({ plan: { id: PLAN_ID, creditsPerMonthTenths: 0 } });
    const outcome = await provisionFreeEntitlement(tx, {
      workspaceId: WORKSPACE_ID,
      currency: "INR",
      at: AT,
    });

    expect(outcome).toEqual({ status: "provisioned", grantedTenths: 0 });
    expect(written.accounts).toHaveLength(1);
    expect(written.subscriptions).toHaveLength(1);
    // A zero-value lot and ledger row would be noise in an append-only ledger.
    expect(written.lots).toHaveLength(0);
    expect(written.ledger).toHaveLength(0);
  });

  it("refuses to hand out an unusable account when the plan seed is missing", async () => {
    const { tx, written } = fakeTx({ plan: null });
    await expect(
      provisionFreeEntitlement(tx, { workspaceId: WORKSPACE_ID, currency: "INR", at: AT }),
    ).rejects.toThrow(MissingFreePlanError);
    expect(written.accounts).toHaveLength(0);
  });
});
