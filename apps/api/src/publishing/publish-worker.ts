import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";

import { publishWorkerEnabled } from "./postiz/postiz-env.js";
import { PostizClient } from "./postiz/postiz.client.js";
import { PublishDispatcher } from "./publish-dispatcher.js";
import { PublishQueue } from "./publish-queue.js";
import {
  AUTO_ATTEMPTS,
  DISPATCH_CONCURRENCY,
  READY_GRACE_MS,
  RECONCILE_CONCURRENCY,
  WATCHDOG_BATCH,
  WATCHDOG_INTERVAL_MS,
} from "./publishing.constants.js";
import {
  PublishDispatchPayloadSchema,
  PublishReconcilePayloadSchema,
} from "./publishing.contract.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { RedisService } from "../common/redis/redis.service.js";
import { isJobEnvelope } from "../jobs/contracts/job-envelope.js";
import { queuePolicyFor, queuePrefix } from "../jobs/jobs.config.js";

import type { Job as BullJob } from "bullmq";

/** A claim this old belonged to a process that died mid-upload (the longest upload is 20 min). */
const ABANDONED_CLAIM_MS = 30 * 60_000;

/**
 * The consumer side of `publish.dispatch` and `publish.reconcile`, inside the
 * API (2026-09-29), plus the watchdog that makes a lost job harmless.
 *
 * **Why in the API.** Sending a post is a file stream and two HTTPS calls to a
 * service on the same machine - no ffmpeg, no model - which is the reasoning
 * `NotifyConsumer` gives for the `notify` queue, and the master plan's own
 * "API publishing worker" (§8.1).
 *
 * **Why a watchdog as well.** The durable state is the `publish_targets` row,
 * not Redis (the lesson of `RepurposeReconciler`): a post confirmed while Redis
 * blinked, an API restarted mid-upload, a check whose job vanished - each is a
 * row the watchdog finds on its next pass (every {@link WATCHDOG_INTERVAL_MS})
 * and enqueues again. Every enqueue is keyed, so it is harmless to repeat.
 *
 * It runs only where a Postiz key is set and `PUBLISH_WORKER_ENABLED` is not
 * `0`: no key, nothing can be posted, and a test suite or the OpenAPI emitter
 * (neither has a key) never opens a BullMQ connection because of it.
 */
@Injectable()
export class PublishWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PublishWorker.name);
  private dispatchWorker: Worker | undefined;
  private reconcileWorker: Worker | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: PublishQueue,
    private readonly dispatcher: PublishDispatcher,
    private readonly postiz: PostizClient,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.postiz.configured) {
      this.logger.log("publishing idle: POSTIZ_API_KEY is not set");
      return;
    }
    if (!publishWorkerEnabled()) {
      this.logger.log("publishing idle (PUBLISH_WORKER_ENABLED=0)");
      return;
    }
    const prefix = queuePrefix();
    this.dispatchWorker = this.startWorker(
      "publish.dispatch",
      DISPATCH_CONCURRENCY,
      prefix,
      (job) => this.handleDispatch(job),
    );
    this.reconcileWorker = this.startWorker(
      "publish.reconcile",
      RECONCILE_CONCURRENCY,
      prefix,
      (job) => this.handleReconcile(job),
    );
    this.watchdog = setInterval(() => {
      void this.sweepOnce();
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref();
    // Whatever was left by the last process: posts confirmed, checks due.
    void this.sweepOnce();
    this.logger.log("publishing running");
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    await Promise.all([this.dispatchWorker?.close(), this.reconcileWorker?.close()]);
    this.dispatchWorker = undefined;
    this.reconcileWorker = undefined;
    await this.sweeping;
  }

  private startWorker(
    name: "publish.dispatch" | "publish.reconcile",
    concurrency: number,
    prefix: string,
    handle: (job: BullJob) => Promise<string>,
  ): Worker {
    const policy = queuePolicyFor(name);
    const worker = new Worker(name, handle, {
      connection: this.redis.client,
      prefix,
      concurrency,
      lockDuration: policy.lockDurationMs,
      stalledInterval: policy.stalledIntervalMs,
      maxStalledCount: policy.maxStalledCount,
    });
    worker.on("error", (error: Error) => {
      // A worker must not take the API down because Redis blinked.
      this.logger.warn({ queue: name, err: error.message }, "publish worker error");
    });
    return worker;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async handleDispatch(job: Pick<BullJob, "data">): Promise<string> {
    const parsed = PublishDispatchPayloadSchema.safeParse(payloadOf(job.data));
    if (!parsed.success) {
      throw new UnrecoverableError("publish.dispatch payload is not valid");
    }
    return this.dispatcher.dispatch(parsed.data);
  }

  async handleReconcile(job: Pick<BullJob, "data">): Promise<string> {
    const parsed = PublishReconcilePayloadSchema.safeParse(payloadOf(job.data));
    if (!parsed.success) {
      throw new UnrecoverableError("publish.reconcile payload is not valid");
    }
    return this.dispatcher.reconcile(parsed.data);
  }

  // -------------------------------------------------------------------------
  // Watchdog
  // -------------------------------------------------------------------------

  /** One pass, unless one is running or the process is stopping. Never throws. */
  sweepOnce(now?: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sweeping !== undefined) return this.sweeping;
    const pass = this.sweep(now ?? Date.now()).finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = pass;
    return pass;
  }

  private async sweep(now: number): Promise<void> {
    try {
      // 1. Confirmed posts with no job: lost enqueues, and posts whose wait is over.
      const ready = await this.prisma.publishTarget.findMany({
        where: {
          OR: [
            {
              status: "ready",
              updatedAt: { lte: new Date(now - READY_GRACE_MS) },
              OR: [{ retryAfter: null }, { retryAfter: { lte: new Date(now) } }],
            },
            { status: "validating", updatedAt: { lte: new Date(now - ABANDONED_CLAIM_MS) } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: WATCHDOG_BATCH,
        select: { id: true, attemptNo: true, workspaceId: true },
      });
      for (const target of ready) {
        if (this.stopping) return;
        await this.queue.dispatch({
          targetId: target.id,
          attemptNo: target.attemptNo,
          workspaceId: target.workspaceId,
        });
      }

      // 2. Passing failures whose wait is over, while automatic attempts remain.
      const due = await this.prisma.publishTarget.findMany({
        where: {
          status: "failed_retryable",
          retryAfter: { lte: new Date(now) },
          attemptNo: { lt: AUTO_ATTEMPTS },
        },
        orderBy: { retryAfter: "asc" },
        take: WATCHDOG_BATCH,
        select: { id: true, attemptNo: true, workspaceId: true, updatedAt: true },
      });
      for (const target of due) {
        if (this.stopping) return;
        const attemptNo = target.attemptNo + 1;
        // Conditional on the row being the one read, so a person's Retry at the
        // same moment does not make two attempts.
        const { count } = await this.prisma.publishTarget.updateMany({
          where: { id: target.id, status: "failed_retryable", attemptNo: target.attemptNo },
          data: {
            status: "ready",
            attemptNo,
            retryAfter: null,
            submittedAt: null,
            checkNo: 0,
            nextCheckAt: null,
            lastErrorCode: null,
            lastErrorSafeMessage: null,
          },
        });
        if (count === 0) continue;
        await this.queue.dispatch({
          targetId: target.id,
          attemptNo,
          workspaceId: target.workspaceId,
        });
      }

      // 3. Posts handed over whose next look is due.
      const checks = await this.prisma.publishTarget.findMany({
        where: {
          status: { in: ["submitted", "processing", "scheduled"] },
          nextCheckAt: { lte: new Date(now) },
        },
        orderBy: { nextCheckAt: "asc" },
        take: WATCHDOG_BATCH,
        select: { id: true, checkNo: true, workspaceId: true },
      });
      for (const target of checks) {
        if (this.stopping) return;
        await this.queue.reconcile({
          targetId: target.id,
          checkNo: target.checkNo + 1,
          workspaceId: target.workspaceId,
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, "publishing watchdog pass failed; the next one retries");
    }
  }
}

/** The payload, from the contract envelope or bare. */
function payloadOf(data: unknown): unknown {
  return isJobEnvelope(data) ? data.payload : data;
}
