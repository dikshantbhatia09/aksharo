import { Injectable, Logger } from "@nestjs/common";

import type { JobCompletion, JobUsage } from "./contracts/completion.js";
import type { QueueName } from "./contracts/queue-names.js";
import type { Job } from "@prisma/client";

/**
 * Per-job-type completion handlers: what a queue's owner does with the payload a
 * worker sends back.
 *
 * A08 owns the *state machine* — the conditional `UPDATE`, the settlement, the
 * dead letter, the realtime echo — and it is the same for every queue. What a
 * completion **means** is not: `ai.transcribe` writes a transcript and an editing
 * document, `render.video` writes an export row, `media.probe` patches an asset.
 * That knowledge belongs to the work package that produced the job, so this is a
 * registry rather than a `switch` inside {@link JobsService}: a feature module
 * registers its handler at boot and `jobs` never learns what a transcript is.
 *
 * **When the handler runs.** Before the status flip, not after it — see
 * `JobsService.complete`. A completion callback is at-least-once, so the handler
 * must be idempotent; in exchange, a handler that throws leaves the job `running`
 * and the callback answers 5xx, which is exactly the signal a retrying worker
 * needs. Running it after the flip would make the first failure permanent: the
 * replay would find a terminal job and answer `already_completed` without ever
 * reaching the handler again.
 */

/** What a handler is given: the job as it was, and the worker's payload. */
export interface JobCompletionContext {
  /** The `jobs` row **before** the completion update, so the hold is still on it. */
  readonly job: Job;
  /** The attempt the signature covered. */
  readonly attemptId: string;
  /** `body.result` — the job type's own shape (CONTRACTS §3). */
  readonly result: Record<string, unknown>;
  readonly usage: JobUsage | undefined;
  /** The completion body, for a handler that needs `finalAttempt` or `error`. */
  readonly completion: JobCompletion;
}

export interface JobCompletionOutcome {
  /**
   * Credits actually consumed, in tenths. Overrides `usage.actualTenths` when the
   * API knows better than the worker did — never more than the hold.
   */
  readonly actualTenths?: number;
  /** Merged into the `job.succeeded` event's `data`, so the audit trail says what landed. */
  readonly data?: Record<string, unknown>;
}

export interface JobCompletionHandler {
  /** The queue whose completions this handler owns. Exactly one handler per queue. */
  readonly jobType: QueueName;
  handle(context: JobCompletionContext): Promise<JobCompletionOutcome | undefined>;
}

/**
 * The registry itself: a map from queue name to the single module that owns it.
 *
 * Registration is imperative (`onModuleInit`) rather than a `multi: true`
 * provider, because the owners live in feature modules that import `JobsModule`
 * and a multi-provider declared over there would never be visible from in here.
 * A second handler for a queue is a **programming error** and throws at boot: two
 * modules writing the same completion is not a configuration a deployment should
 * be allowed to reach.
 */
@Injectable()
export class JobCompletionRegistry {
  private readonly logger = new Logger(JobCompletionRegistry.name);
  private readonly handlers = new Map<string, JobCompletionHandler>();

  register(handler: JobCompletionHandler): void {
    const existing = this.handlers.get(handler.jobType);
    if (existing !== undefined && existing !== handler) {
      throw new Error(
        `A completion handler for "${handler.jobType}" is already registered ` +
          `(${existing.constructor.name}); ${handler.constructor.name} may not replace it.`,
      );
    }
    this.handlers.set(handler.jobType, handler);
    this.logger.log({ jobType: handler.jobType }, "completion handler registered");
  }

  handlerFor(jobType: string): JobCompletionHandler | undefined {
    return this.handlers.get(jobType);
  }

  /** The queues that have an owner, for diagnostics and tests. */
  registeredTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
