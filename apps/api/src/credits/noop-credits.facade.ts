import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { CreditsInsufficientError } from "./credits.facade.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { FREE_TIER_DAILY_MINUTES, FREE_TIER_WINDOW_MS } from "../jobs/jobs.config.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";

import type {
  CreditsFacade,
  GrantLotInput,
  GrantLotResult,
  ReleaseInput,
  ReserveInput,
  ReserveResult,
  SettleInput,
  SettleResult,
} from "./credits.facade.js";

/** Tenths of a credit in one whole credit (CONTRACTS §0). */
const TENTHS_PER_CREDIT = 10;

/**
 * Free-tier allowance in tenths. One credit buys one minute of cloud
 * transcription, so minutes and credits are the same number here.
 */
export const FREE_TIER_DAILY_TENTHS = FREE_TIER_DAILY_MINUTES * TENTHS_PER_CREDIT;

type HoldStatus = "held" | "settled" | "released";

interface Hold {
  readonly holdId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly amountTenths: number;
  readonly reason: string;
  readonly at: number;
  status: HoldStatus;
  settledTenths: number;
}

/**
 * The Wave 1 `CreditsFacade`: correct *shape*, no ledger.
 *
 * It moves no money and writes no row to `credit_accounts`, `credit_lots`,
 * `credit_holds` or `credit_ledger` — B02 owns those tables and their invariants,
 * and a half-written hold with no ledger entry would break invariant 1 on day one.
 * What it does provide is everything the producers and the completion path need to
 * be written and tested now:
 *
 * - a synthetic `holdId` per job, so `settle`/`release` have something to address;
 * - **idempotent** `settle` and `release`, so a replayed completion callback
 *   settles exactly once (THREAT-MODEL T8) and a spy can prove it;
 * - the free-tier daily cap of {@link FREE_TIER_DAILY_MINUTES} minutes
 *   (THREAT-MODEL T23), which is the only real limit A08 can enforce without a
 *   balance.
 *
 * State lives in memory, so it resets on restart and is per-instance. That is
 * acceptable precisely because it is not the record: B02 replaces this class with
 * the ledger-backed implementation behind the same interface.
 */
@Injectable()
export class NoopCreditsFacade implements CreditsFacade {
  private readonly logger = new Logger(NoopCreditsFacade.name);
  private readonly holds = new Map<string, Hold>();
  /** Reservations per workspace within the rolling free-tier window. */
  private readonly recent = new Map<string, { at: number; tenths: number }[]>();

  constructor(private readonly prisma: PrismaService) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    assertNonNegativeInteger(input.worstCaseTenths, "worstCaseTenths");

    const plan = await resolveWorkspacePlan(this.prisma, input.workspaceId);
    if (plan === "free") this.assertWithinFreeTierAllowance(input);

    const holdId = ulid();
    this.holds.set(holdId, {
      holdId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      amountTenths: input.worstCaseTenths,
      reason: input.reason,
      at: Date.now(),
      status: "held",
      settledTenths: 0,
    });
    this.remember(input.workspaceId, input.worstCaseTenths);

    this.logger.debug(
      { holdId, workspaceId: input.workspaceId, jobId: input.jobId, plan },
      "credits reserved (no-op)",
    );
    return { holdId };
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    assertNonNegativeInteger(input.actualTenths, "actualTenths");

    const hold = this.holds.get(input.holdId);
    // Unknown or already-terminal holds are a no-op, not an error: the completion
    // path is at-least-once by construction (CONTRACTS §3).
    if (hold === undefined) return { settledTenths: input.actualTenths };
    if (hold.status !== "held") return { settledTenths: hold.settledTenths };

    hold.status = "settled";
    hold.settledTenths = input.actualTenths;
    return { settledTenths: input.actualTenths };
  }

  async release(input: ReleaseInput): Promise<void> {
    const hold = this.holds.get(input.holdId);
    if (hold === undefined || hold.status !== "held") return;
    hold.status = "released";
    this.forget(hold.workspaceId, hold.at, hold.amountTenths);
  }

  async grantLot(input: GrantLotInput): Promise<GrantLotResult> {
    assertNonNegativeInteger(input.tenths, "tenths");
    // No lot table in Wave 1: the id exists so B01/B04/B07 can be written against
    // the final signature and swapped onto B02's implementation unchanged.
    const lotId = ulid();
    this.logger.debug(
      { lotId, workspaceId: input.workspaceId, source: input.source },
      "credits granted (no-op)",
    );
    return { lotId };
  }

  /** Test and diagnostic hook: the recorded state of a hold. */
  holdStatus(holdId: string): HoldStatus | undefined {
    return this.holds.get(holdId)?.status;
  }

  /** Test hook: drop all in-memory state. */
  reset(): void {
    this.holds.clear();
    this.recent.clear();
  }

  private assertWithinFreeTierAllowance(input: ReserveInput): void {
    const used = this.usedInWindow(input.workspaceId);
    const remaining = FREE_TIER_DAILY_TENTHS - used;
    if (input.worstCaseTenths <= remaining) return;

    throw new CreditsInsufficientError(
      input.worstCaseTenths - Math.max(0, remaining),
      `The free plan allows ${String(FREE_TIER_DAILY_MINUTES)} minutes of cloud processing a day.`,
      {
        plan: "free",
        dailyCapTenths: FREE_TIER_DAILY_TENTHS,
        usedTenths: used,
        requestedTenths: input.worstCaseTenths,
      },
    );
  }

  private usedInWindow(workspaceId: string): number {
    const cutoff = Date.now() - FREE_TIER_WINDOW_MS;
    const entries = (this.recent.get(workspaceId) ?? []).filter((entry) => entry.at >= cutoff);
    this.recent.set(workspaceId, entries);
    return entries.reduce((total, entry) => total + entry.tenths, 0);
  }

  private remember(workspaceId: string, tenths: number): void {
    const entries = this.recent.get(workspaceId) ?? [];
    entries.push({ at: Date.now(), tenths });
    this.recent.set(workspaceId, entries);
  }

  /** A released hold never ran, so it must not count against the daily allowance. */
  private forget(workspaceId: string, at: number, tenths: number): void {
    const entries = this.recent.get(workspaceId);
    if (entries === undefined) return;
    const index = entries.findIndex((entry) => entry.at === at && entry.tenths === tenths);
    if (index >= 0) entries.splice(index, 1);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of tenths, got ${value}`);
  }
}
