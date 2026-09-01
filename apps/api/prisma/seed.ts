/**
 * Database seed.
 *
 * Idempotent by construction: every row is written with `upsert` keyed on a
 * natural key (plan key, flag key, workspace slug, user email, style key) or on a
 * deterministic ULID from `seedUlid()`. Running it twice leaves the row counts
 * unchanged — asserted by `test/seed.spec.ts`.
 *
 * What it creates:
 *   * the five plans of 04 §Plans, with INR/USD prices, monthly credit grants and
 *     the entitlements JSON (operation gating derived from `@montaj/config`);
 *   * the system caption styles, with the parity flags left at their pessimistic
 *     defaults (assRenderable false, assExportable false, requiresLayoutMetrics
 *     true) because only the A18a parity gate may write them (D33);
 *   * four feature flags, all off;
 *   * one admin user and a demo personal workspace with an owner membership, a
 *     credit account holding the free monthly grant as a lot plus its ledger row,
 *     and a free-plan subscription.
 *
 * Run with: pnpm --filter @montaj/api db:seed
 */
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { BRAND } from "@montaj/config";

import {
  FEATURE_FLAG_SEEDS,
  loadSystemStyles,
  PLAN_SEEDS,
  seedUlid,
  type StyleSource,
} from "./seed-data.js";
import { loadRepoDotenv } from "../src/config/dotenv.js";

export interface SeedResult {
  readonly plans: number;
  readonly styles: number;
  readonly styleSource: StyleSource;
  readonly featureFlags: number;
  readonly adminEmail: string;
  readonly workspaceSlug: string;
  readonly grantTenths: number;
}

const ADMIN_EMAIL = `admin@${BRAND.domain}`;
const DEMO_SLUG = "demo";
/** Maharashtra. A validated GST State code is mandatory for Indian workspaces (D41). */
const DEMO_STATE_CODE = "27";

/** One month from `from`, used for the free plan's grant window. */
function addMonth(from: Date): Date {
  const end = new Date(from);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

export async function seed(prisma: PrismaClient): Promise<SeedResult> {
  // --- Plans -------------------------------------------------------------
  for (const plan of PLAN_SEEDS) {
    await prisma.plan.upsert({
      where: { key: plan.key },
      create: {
        id: seedUlid(`plan:${plan.key}`),
        key: plan.key,
        name: plan.name,
        prices: plan.prices,
        creditsPerMonthTenths: plan.creditsPerMonthTenths,
        seatPrice: plan.seatPrice ?? undefined,
        entitlements: plan.entitlements,
        active: true,
      },
      update: {
        name: plan.name,
        prices: plan.prices,
        creditsPerMonthTenths: plan.creditsPerMonthTenths,
        seatPrice: plan.seatPrice ?? undefined,
        entitlements: plan.entitlements,
        active: true,
      },
    });
  }

  // --- System caption styles ---------------------------------------------
  const { source: styleSource, styles } = loadSystemStyles(resolve(__dirname, "..", "..", ".."));
  for (const style of styles) {
    // System styles have `workspaceId = null`, and PostgreSQL treats every NULL as
    // distinct — so `@@unique([workspaceId, key])` does not constrain them and
    // Prisma will not accept a null in a compound `where`. Uniqueness comes from
    // the partial index `style_presets_system_key_key` (prisma/sql/0002), and the
    // upsert is spelled out by hand against it.
    const existing = await prisma.stylePreset.findFirst({
      where: { workspaceId: null, key: style.key },
      select: { id: true },
    });

    const fields = {
      name: style.name,
      category: style.category,
      doc: style.doc,
      minPlan: style.minPlan,
      // assRenderable / assExportable / requiresLayoutMetrics / parityScore are
      // deliberately NOT written here: the A18a parity gate owns them (D33).
    };

    if (existing === null) {
      await prisma.stylePreset.create({
        data: { id: seedUlid(`style:${style.key}`), workspaceId: null, key: style.key, ...fields },
      });
    } else {
      await prisma.stylePreset.update({ where: { id: existing.id }, data: fields });
    }
  }

  // --- Feature flags ------------------------------------------------------
  for (const flag of FEATURE_FLAG_SEEDS) {
    await prisma.featureFlag.upsert({
      where: { key: flag.key },
      create: {
        id: seedUlid(`flag:${flag.key}`),
        key: flag.key,
        description: flag.description,
        enabled: false,
        rolloutPct: 0,
      },
      // `enabled` and `rolloutPct` are left alone: an operator who turned a flag on
      // in staging must not have it turned off again by a redeploy's seed.
      update: { description: flag.description },
    });
  }

  // --- Admin user, demo workspace, credits, subscription ------------------
  const adminId = seedUlid("user:admin");
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      id: adminId,
      email: ADMIN_EMAIL,
      name: "Aksharo Admin",
      emailVerifiedAt: new Date(),
      locale: "en-IN",
      jurisdiction: "IN",
      ageBracket: "adult",
      // No password hash: local sign-in is A04's job and a seeded credential would
      // be a shipped secret (THREAT-MODEL T21).
    },
    update: { name: "Aksharo Admin" },
  });

  const freePlan = await prisma.plan.findUniqueOrThrow({ where: { key: "free" } });

  const workspace = await prisma.workspace.upsert({
    where: { slug: DEMO_SLUG },
    create: {
      id: seedUlid("workspace:demo"),
      slug: DEMO_SLUG,
      name: "Demo workspace",
      type: "personal",
      ownerId: admin.id,
      region: "in",
      currency: "INR",
      billingCountry: "IN",
      billingStateCode: DEMO_STATE_CODE,
      retentionDays: 7,
    },
    update: { name: "Demo workspace", ownerId: admin.id },
  });

  await prisma.membership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: admin.id } },
    create: {
      id: seedUlid("membership:demo-owner"),
      workspaceId: workspace.id,
      userId: admin.id,
      role: "owner",
      status: "active",
    },
    update: { role: "owner", status: "active" },
  });

  const periodStart = new Date(Date.UTC(2026, 0, 1));
  const periodEnd = addMonth(periodStart);
  const grantTenths = freePlan.creditsPerMonthTenths;

  const account = await prisma.creditAccount.upsert({
    where: { workspaceId: workspace.id },
    create: {
      id: seedUlid("credit-account:demo"),
      workspaceId: workspace.id,
      balanceTenths: grantTenths,
      monthlyGrantTenths: grantTenths,
      grantResetAt: periodEnd,
    },
    update: { monthlyGrantTenths: grantTenths, grantResetAt: periodEnd },
  });

  // The lot and the ledger row are written alongside the balance so the seeded
  // state satisfies invariant 1 (balance = Σ lot remainders = Σ ledger deltas).
  const lotId = seedUlid("credit-lot:demo-grant");
  await prisma.creditLot.upsert({
    where: { id: lotId },
    create: {
      id: lotId,
      accountId: account.id,
      source: "grant",
      grantedTenths: grantTenths,
      remainingTenths: grantTenths,
      expiresAt: periodEnd,
    },
    update: { grantedTenths: grantTenths },
  });

  const ledgerId = seedUlid("credit-ledger:demo-grant");
  await prisma.creditLedger.upsert({
    where: { id: ledgerId },
    create: {
      id: ledgerId,
      accountId: account.id,
      deltaTenths: grantTenths,
      kind: "grant",
      refType: "plan",
      refId: freePlan.id,
      lotId,
      balanceAfterTenths: grantTenths,
      at: periodStart,
    },
    // Append-only: an existing ledger row is never rewritten (06 invariant 1).
    update: {},
  });

  const subscriptionId = seedUlid("subscription:demo-free");
  await prisma.subscription.upsert({
    where: { id: subscriptionId },
    create: {
      id: subscriptionId,
      workspaceId: workspace.id,
      planId: freePlan.id,
      provider: "none",
      status: "active",
      interval: "month",
      currency: "INR",
      listPriceMinor: 0,
      taxInclusive: true,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      seats: 1,
    },
    update: { planId: freePlan.id, status: "active", currentPeriodEnd: periodEnd },
  });

  return {
    plans: PLAN_SEEDS.length,
    styles: styles.length,
    styleSource,
    featureFlags: FEATURE_FLAG_SEEDS.length,
    adminEmail: ADMIN_EMAIL,
    workspaceSlug: workspace.slug,
    grantTenths,
  };
}

async function main(): Promise<void> {
  loadRepoDotenv(resolve(__dirname, ".."));
  const prisma = new PrismaClient();
  try {
    const result = await seed(prisma);
    console.warn(
      `[db:seed] ${result.plans} plans, ${result.styles} system styles (source: ${result.styleSource}), ` +
        `${result.featureFlags} feature flags.`,
    );
    console.warn(
      `[db:seed] admin ${result.adminEmail}, workspace "${result.workspaceSlug}" ` +
        `with ${result.grantTenths / 10} credits granted.`,
    );
    if (result.styleSource === "fallback") {
      console.warn(
        "[db:seed] NOTE: @montaj/caption-styles has no fixtures yet (A02 in flight), " +
          "so five placeholder StyleDocs were seeded. Re-run db:seed once A02 lands.",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
