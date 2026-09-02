import { Injectable } from "@nestjs/common";

import { LedgerCreditsFacade } from "./ledger-credits.facade.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export interface OrphanedHold {
  readonly holdId: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly queue: string;
  readonly jobStatus: string;
  readonly amountTenths: number;
  readonly heldSince: string;
}

export interface OrphanedHoldResolution {
  readonly holdId: string;
  readonly jobId: string;
  readonly queue: string;
  readonly action: "released" | "settled" | "would_release" | "would_settle" | "failed";
  readonly error?: string;
}

/**
 * Finds `credit_holds` still `status = 'held'` whose job has already reached a
 * terminal status, and resolves each one per the job's outcome.
 *
 * **How a hold ends up orphaned at all**, since `JobsService.complete` always
 * settles or releases the hold in the same call that flips the job terminal:
 * a completion callback that updates the job row and then crashes (or loses its
 * database connection) before the credits call; a process killed between the two
 * statements; or a hand-edited `jobs` row during an incident. None of these are
 * "should never happen" in the way a CHECK-constraint violation is — they are
 * exactly the two-writes-are-not-one-transaction gap `docs/runbooks/
 * credits-orphaned-holds.md` exists for.
 *
 * **The resolution follows the job, not a guess.** A `succeeded` job settles for
 * whatever `jobs.credits_charged_tenths` already records — the completion
 * handler already decided that number and writing it into the ledger a second
 * (later) time must not re-derive it. Every other terminal status (`failed`,
 * `cancelled`) releases the hold in full: those paths never charge.
 *
 * Read-only by default (`resolveAll`/`resolveOne` take `dryRun`, defaulting to
 * `true`), matching `DlqService.bulk` and the runbook conventions of A08b.
 */
@Injectable()
export class CreditOrphanedHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: LedgerCreditsFacade,
  ) {}

  async find(): Promise<readonly OrphanedHold[]> {
    const rows = await this.prisma.creditHold.findMany({
      where: { status: "held", job: { status: { in: [...TERMINAL_JOB_STATUSES] } } },
      include: {
        job: {
          select: { workspaceId: true, type: true, status: true, creditsChargedTenths: true },
        },
      },
      orderBy: { at: "asc" },
    });
    return rows.map((row) => ({
      holdId: row.id,
      jobId: row.jobId,
      workspaceId: row.job.workspaceId,
      queue: row.job.type,
      jobStatus: row.job.status,
      amountTenths: row.amountTenths,
      heldSince: row.at.toISOString(),
    }));
  }

  /** Resolve every orphaned hold, or only `holdIds` when given. `dryRun` defaults to true. */
  async resolveAll(
    input: {
      readonly holdIds?: readonly string[];
      readonly dryRun?: boolean;
    } = {},
  ): Promise<readonly OrphanedHoldResolution[]> {
    const dryRun = input.dryRun ?? true;
    const orphans = await this.find();
    const selected =
      input.holdIds === undefined || input.holdIds.length === 0
        ? orphans
        : orphans.filter((o) => input.holdIds?.includes(o.holdId) === true);

    const results: OrphanedHoldResolution[] = [];
    for (const orphan of selected) results.push(await this.resolveOne(orphan, dryRun));
    return results;
  }

  private async resolveOne(orphan: OrphanedHold, dryRun: boolean): Promise<OrphanedHoldResolution> {
    const wantsSettle = orphan.jobStatus === "succeeded";
    if (dryRun) {
      return {
        holdId: orphan.holdId,
        jobId: orphan.jobId,
        queue: orphan.queue,
        action: wantsSettle ? "would_settle" : "would_release",
      };
    }

    try {
      if (wantsSettle) {
        const job = await this.prisma.job.findUniqueOrThrow({
          where: { id: orphan.jobId },
          select: { creditsChargedTenths: true },
        });
        await this.credits.settle({
          holdId: orphan.holdId,
          actualTenths: job.creditsChargedTenths,
        });
        return {
          holdId: orphan.holdId,
          jobId: orphan.jobId,
          queue: orphan.queue,
          action: "settled",
        };
      }
      await this.credits.release({ holdId: orphan.holdId });
      return {
        holdId: orphan.holdId,
        jobId: orphan.jobId,
        queue: orphan.queue,
        action: "released",
      };
    } catch (error) {
      return {
        holdId: orphan.holdId,
        jobId: orphan.jobId,
        queue: orphan.queue,
        action: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
