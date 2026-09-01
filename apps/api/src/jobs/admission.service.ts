import { HttpStatus, Injectable } from "@nestjs/common";

import { planLimits } from "./jobs.config.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { resolveWorkspacePlan } from "./plan.js";
import { AppException } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { PlanLimits } from "./jobs.config.js";
import type { Prisma } from "@prisma/client";

/** Job states that occupy a workspace's lane and hold its credits. */
export const IN_FLIGHT_STATUSES = ["queued", "running"] as const;

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
 * - **Enqueued credits.** The sum of the worst-case holds of every job in
 *   `queued` or `running` may not exceed the plan cap. This is the one that stops
 *   a runaway script from spending a year's credits in a minute.
 * - **Concurrency lane.** The *count* of in-flight jobs may not exceed the plan
 *   lane, so a workspace cannot fill a queue with free jobs and starve everybody
 *   else behind it.
 *
 * The credit sum comes from `jobs.credits_charged_tenths`, which the enqueue path
 * writes with the worst-case hold and the completion path overwrites with the
 * settled amount. For an in-flight job the two are the same number, so the column
 * is a faithful "what this job is currently costing" for exactly the rows this
 * query selects — and it needs no schema change, which matters because the credit
 * tables belong to B02.
 */
@Injectable()
export class AdmissionService {
  constructor(private readonly prisma: PrismaService) {}

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
    };

    const [count, sum] = await Promise.all([
      this.prisma.job.count({ where }),
      this.prisma.job.aggregate({ where, _sum: { creditsChargedTenths: true } }),
    ]);
    const inFlightTenths = sum._sum?.creditsChargedTenths ?? 0;

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
