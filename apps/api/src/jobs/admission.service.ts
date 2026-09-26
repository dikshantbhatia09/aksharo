import { HttpStatus, Injectable } from "@nestjs/common";

import { QUEUE_NAMES } from "./contracts/queue-names.js";
import { planLimits } from "./jobs.config.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { resolveWorkspacePlan } from "./plan.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { QueueName } from "./contracts/queue-names.js";
import type { PlanLimits } from "./jobs.config.js";
import type { Prisma } from "@prisma/client";

/** Job states that occupy a workspace's lane and hold its credits. */
export const IN_FLIGHT_STATUSES = ["queued", "running"] as const;

/**
 * Job types that run in the background and never take a plan's lane.
 *
 * `ai.faces` is free, skips admission itself (`FacesTrigger`) and is queued the
 * moment a proxy lands — for every upload, every repurposed source and every
 * clip. Counted, two of them filled the Free plan's two-job lane, and the
 * transcription or highlight discovery queued right behind them was refused:
 * paid, user-visible work lost to invisible, optional work (clips hardening
 * 2026-09-26, §5). It still holds its own row and still runs; it just no
 * longer counts against anyone else.
 */
export const BACKGROUND_JOB_TYPES: ReadonlySet<QueueName> = new Set<QueueName>(["ai.faces"]);

/**
 * The job types that DO occupy the lane, spelled as a list rather than as
 * "not the background ones": a queue added to CONTRACTS §3 counts until
 * someone decides otherwise, which is the safe default for a denial-of-wallet
 * control.
 */
const LANE_JOB_TYPES: readonly QueueName[] = QUEUE_NAMES.filter(
  (type) => !BACKGROUND_JOB_TYPES.has(type),
);

export interface AdmissionDecision {
  readonly limits: PlanLimits;
  readonly inFlightJobs: number;
  readonly inFlightTenths: number;
}

/**
 * Admission control — THREAT-MODEL T23, denial of wallet.
 *
 * Two independent caps, both per workspace, both checked before a job row exists:
 *
 * - **Enqueued credits.** The sum of every OPEN hold (`credit_holds.status =
 *   'held'`) on the workspace's account may not exceed the plan cap. This is the
 *   one that stops a runaway script from spending a year's credits in a minute.
 * - **Concurrency lane.** The *count* of in-flight jobs may not exceed the plan
 *   lane, so a workspace cannot fill a queue with free jobs and starve everybody
 *   else behind it. {@link BACKGROUND_JOB_TYPES} are not counted.
 *
 * **B02b: the credit sum is `credit_holds`, not `jobs.credits_charged_tenths`.**
 * Before B02 the ledger did not exist and that column was the only number there
 * was; now it is a denormalised DISPLAY copy — the worst-case hold at enqueue,
 * the settled amount after `complete()` — useful for `GET /jobs` and never read
 * for a decision that gates spend. `credit_holds` is the ledger's own record of
 * what is actually reserved right now (`LedgerCreditsFacade.reserve`/`settle`/
 * `release` are what move a hold in and out of `held`), so it cannot drift from
 * what `CreditsFacade` itself would report, and a hold this query does not see
 * is not a hold that can still be spent. See `apps/api/src/credits/README.md`
 * "Which number is authoritative".
 */
@Injectable()
export class AdmissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The plan's limits, with no cap checked.
   *
   * For a job the API has already decided must run: `media.probe` completing and
   * asking for its `media.proxy` (A07). The proxy is the second half of one piece
   * of work the workspace was admitted for at upload, and making it queue behind a
   * fresh admission decision would 429 the *pipeline* on a Free workspace whose
   * lane the still-open probe is itself occupying. The priority and the queue-wait
   * budget still come from the plan, because those are scheduling, not rationing.
   *
   * Never reachable from a worker: `EnqueueChildSchema` has no field that selects
   * it, so `POST /internal/jobs/{id}/enqueue-child` always goes through
   * {@link admit} (THREAT-MODEL T23).
   */
  async limitsFor(workspaceId: string): Promise<PlanLimits> {
    return planLimits(await resolveWorkspacePlan(this.prisma, workspaceId));
  }

  /** @throws AppException 429 when either cap is exceeded. */
  async admit(input: {
    readonly workspaceId: string;
    readonly worstCaseTenths: number;
  }): Promise<AdmissionDecision> {
    const plan = await resolveWorkspacePlan(this.prisma, input.workspaceId);
    const limits = planLimits(plan);

    const where: Prisma.JobWhereInput = {
      workspaceId: input.workspaceId,
      status: { in: [...IN_FLIGHT_STATUSES] },
      type: { in: [...LANE_JOB_TYPES] },
    };

    const [count, holdsSum] = await Promise.all([
      this.prisma.job.count({ where }),
      this.prisma.creditHold.aggregate({
        where: { status: "held", account: { workspaceId: input.workspaceId } },
        _sum: { amountTenths: true },
      }),
    ]);
    const inFlightTenths = holdsSum._sum?.amountTenths ?? 0;

    if (count >= limits.concurrencyLane) {
      throw new AppException(
        JOB_ERROR_CODES.concurrencyCap,
        `This workspace already has ${String(count)} jobs in flight; the ${limits.plan} plan allows ${String(limits.concurrencyLane)}.`,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          plan: limits.plan,
          inFlightJobs: count,
          concurrencyLane: limits.concurrencyLane,
          retryAfterSeconds: 30,
        },
      );
    }

    if (inFlightTenths + input.worstCaseTenths > limits.enqueuedCapTenths) {
      throw new AppException(
        JOB_ERROR_CODES.enqueueCap,
        `Queued jobs would hold more credits than the ${limits.plan} plan allows at once.`,
        HttpStatus.TOO_MANY_REQUESTS,
        {
          plan: limits.plan,
          inFlightTenths,
          requestedTenths: input.worstCaseTenths,
          enqueuedCapTenths: limits.enqueuedCapTenths,
          retryAfterSeconds: 30,
        },
      );
    }

    return { limits, inFlightJobs: count, inFlightTenths };
  }
}
