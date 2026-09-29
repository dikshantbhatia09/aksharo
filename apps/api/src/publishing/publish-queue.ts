import { Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import {
  PUBLISHING_SCHEMA_VERSION,
  publishDispatchJobKey,
  publishReconcileJobKey,
} from "./publishing.contract.js";
import { buildJobEnvelope } from "../jobs/contracts/job-envelope.js";
import { queuePolicyFor } from "../jobs/jobs.config.js";
import { QueueRegistry } from "../jobs/queue.registry.js";

import type { JobsOptions } from "bullmq";

/**
 * The producer side of `publish.dispatch` and `publish.reconcile` (2026-09-29).
 *
 * Like `notify`, these jobs have no `jobs` row: nothing bills them and no
 * worker posts a completion callback - the API consumes them itself
 * (`publish-worker.ts`). The `publish_targets` row is the record; Redis only
 * carries "look at this post now".
 *
 * **The BullMQ id is the contract's job key** (`publish.dispatch:{id}:{attempt}`,
 * `publish.reconcile:{id}` plus the check number), with `-` for `:` because
 * BullMQ refuses a colon in a custom id. So a second enqueue of the same
 * attempt or check while one is waiting is a no-op, which is what lets the
 * watchdog re-enqueue freely. Finished jobs are removed at once: the id must be
 * free again for the watchdog, and `attempts: 1` (the `publish` family's policy
 * in `jobs.config.ts`) means BullMQ never retries a post by itself.
 *
 * Enqueueing never throws: a post whose enqueue failed is still `ready` in the
 * database, and the watchdog enqueues it on its next pass.
 */

/** BullMQ custom ids may not contain `:`. */
export function bullIdOf(jobKey: string): string {
  return jobKey.replace(/:/g, "-");
}

@Injectable()
export class PublishQueue {
  private readonly logger = new Logger(PublishQueue.name);

  constructor(private readonly queues: QueueRegistry) {}

  async dispatch(input: {
    readonly targetId: string;
    readonly attemptNo: number;
    readonly workspaceId: string;
  }): Promise<boolean> {
    const jobKey = publishDispatchJobKey(input.targetId, input.attemptNo);
    return this.add("publish.dispatch", jobKey, input.workspaceId, {
      schemaVersion: PUBLISHING_SCHEMA_VERSION,
      publishTargetId: input.targetId,
      attemptNo: input.attemptNo,
    });
  }

  async reconcile(input: {
    readonly targetId: string;
    readonly checkNo: number;
    readonly workspaceId: string;
  }): Promise<boolean> {
    const jobKey = `${publishReconcileJobKey(input.targetId)}:${String(input.checkNo)}`;
    return this.add("publish.reconcile", jobKey, input.workspaceId, {
      schemaVersion: PUBLISHING_SCHEMA_VERSION,
      publishTargetId: input.targetId,
      checkNo: input.checkNo,
    });
  }

  private async add(
    queue: "publish.dispatch" | "publish.reconcile",
    jobKey: string,
    workspaceId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const envelope = buildJobEnvelope({
      jobId: ulid(),
      attemptId: ulid(),
      workspaceId,
      priority: 1,
      jobKey,
      createdAt: new Date(),
      payload,
    });
    const policy = queuePolicyFor(queue);
    const options: JobsOptions = {
      jobId: bullIdOf(jobKey),
      attempts: policy.attempts,
      removeOnComplete: true,
      removeOnFail: true,
    };
    try {
      await this.queues.queue(queue).add(queue, envelope, options);
      return true;
    } catch (error) {
      this.logger.warn(
        { queue, jobKey, err: error },
        "could not enqueue; the publishing watchdog picks it up",
      );
      return false;
    }
  }
}
