import { CallbackClient } from "./callbacks.js";
import { MediaJobError, describeError } from "./errors.js";
import { logger } from "./logger.js";
import { heartbeatIntervalMs } from "./policies.js";
import { isJobEnvelope, isMediaPayload } from "./queues.js";
import { mediaPrefix } from "./storage-keys.js";
import { storesFrom } from "./storage.js";

import type { JobUsage } from "./callbacks.js";
import type { MediaFailureReason } from "./errors.js";
import type { JobEnvelope, MediaProbePayload } from "./queues.js";
import type { Settings } from "./settings.js";
import type { ObjectStore } from "./storage.js";
import type { Job } from "bullmq";

/**
 * The worker runtime: one handler per queue, and the retry contract with A08.
 *
 * ## Callback semantics
 *
 * ```
 * job arrives -> progress(0)          -> the API flips the row to `running`
 *             -> processor runs       -> heartbeat every lockDuration/3
 *             -> complete(succeeded)  -> the API settles credits and fans out
 * ```
 *
 * ## Retry semantics — the part that is easy to get wrong
 *
 * A08 gives every `media.*` job **three** BullMQ attempts, but the `jobs` row has
 * a **single** `attemptId`. So a failed completion posted on the first BullMQ
 * attempt moves the row to `failed`, and the second attempt's completion is then
 * rejected as `already_completed` — the retry would be invisible to the product.
 * The rule that falls out of that, identical to `worker_ai/runtime.py`:
 *
 * | Failure                     | Completion posted?           | Exception re-raised? |
 * | --------------------------- | ---------------------------- | -------------------- |
 * | retryable, attempts remain  | **no**                       | yes — BullMQ retries |
 * | retryable, final attempt    | yes, `finalAttempt: true`    | yes — BullMQ fails   |
 * | non-retryable (any attempt) | yes, `error.retryable:false` | yes                  |
 * | envelope does not parse     | no (there is no jobId)       | yes                  |
 *
 * `finalAttempt` and `error.retryable === false` are exactly the two flags
 * `markDeadLetterIfFinal` reads, so a job that has run out of road lands in the
 * dead-letter queue with its last error attached.
 *
 * **The media row is only marked `failed` when the failure is terminal.** An asset
 * shown as failed while BullMQ still has two attempts left is a lie the next
 * attempt has to undo, and the user has watched it happen.
 */

/** Everything a processor is handed. */
export interface JobContext {
  readonly settings: Settings;
  readonly envelope: JobEnvelope<MediaProbePayload>;
  readonly payload: MediaProbePayload;
  /** `ws/{ws}/p/{project}/media/{media}` — every derived key hangs off this. */
  readonly derivedPrefix: string;
  readonly raw: ObjectStore;
  readonly derived: ObjectStore;
  readonly callbacks: CallbackClient;
  /** Report progress; throttled by {@link Heartbeat}, safe to call often. */
  report(progress: number, message?: string): void;
  /** Aborted when the worker is shutting down, so ffmpeg is killed with it. */
  readonly signal: AbortSignal;
}

export interface ProcessorOutcome {
  readonly result: Record<string, unknown>;
  readonly usage?: JobUsage;
  /** Applied to `media_assets` through the signed patch before the completion. */
  readonly mediaPatch?: Record<string, unknown>;
}

export type Processor = (context: JobContext) => Promise<ProcessorOutcome>;

/** Collaborators built once per process. */
export interface Services {
  readonly settings: Settings;
  readonly callbacks: CallbackClient;
  readonly raw: ObjectStore;
  readonly derived: ObjectStore;
}

export function buildServices(settings: Settings): Services {
  const stores = storesFrom(settings.env);
  return {
    settings,
    callbacks: new CallbackClient(settings.env.API_ORIGIN, settings.env.INTERNAL_CALLBACK_SECRET),
    raw: stores.raw,
    derived: stores.derived,
  };
}

/**
 * Post progress at most once per `intervalMs`, and always for 0 and 100.
 *
 * The progress callback is *also* the API-side heartbeat
 * (`JobsService.recordProgress` promotes a `queued` job to `running`), so a long
 * encode that has nothing new to say still has to call it — hence
 * {@link Heartbeat.start}, which re-posts the last known percentage on a timer
 * even when the processor has gone quiet inside one ffmpeg run.
 */
export class Heartbeat {
  private last = -1;
  private lastPostedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private inflight = false;

  constructor(
    private readonly callbacks: CallbackClient,
    private readonly jobId: string,
    private readonly attemptId: string,
    private readonly intervalMs: number,
  ) {}

  /** Note a new percentage, and post it if enough time has passed. */
  report(progress: number, message?: string): void {
    this.last = progress;
    if (Date.now() - this.lastPostedAt < this.intervalMs) return;
    this.post(progress, message);
  }

  /** Post immediately, whatever the throttle says. For 0 and 100. */
  async postNow(progress: number, message?: string): Promise<void> {
    this.last = progress;
    this.lastPostedAt = Date.now();
    await this.callbacks.progress(this.jobId, this.attemptId, progress, {
      ...(message === undefined ? {} : { message }),
    });
  }

  /** Begin re-posting the last percentage on a timer. */
  start(): void {
    this.timer ??= setInterval(() => {
      if (this.last >= 0) this.post(this.last);
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private post(progress: number, message?: string): void {
    if (this.inflight) return;
    this.inflight = true;
    this.lastPostedAt = Date.now();
    void this.callbacks
      .progress(this.jobId, this.attemptId, progress, {
        ...(message === undefined ? {} : { message }),
      })
      .catch((error: unknown) => {
        // A dropped heartbeat is not a reason to fail work that is going fine: the
        // BullMQ lock is renewed separately, and the next beat will land.
        logger.warn("heartbeat not delivered", { jobId: this.jobId, error: describeError(error) });
      })
      .finally(() => {
        this.inflight = false;
      });
  }
}

/**
 * Wrap a processor as a BullMQ handler: envelope validation, heartbeats, the
 * signed patch, the completion callback and the retry table above.
 */
export function makeHandler(
  queueName: string,
  processor: Processor,
  services: Services,
  shutdown: AbortSignal,
): (job: Job) => Promise<Record<string, unknown>> {
  const interval = heartbeatIntervalMs(queueName);

  return async function handle(job: Job): Promise<Record<string, unknown>> {
    if (!isJobEnvelope(job.data) || !isMediaPayload(job.data.payload)) {
      // A malformed job is a producer bug: there is no jobId to complete against
      // and no amount of retrying will change the bytes in Redis.
      throw new Error(
        `Job ${job.id ?? "?"} on ${job.queueName} does not match the CONTRACTS §3 envelope.`,
      );
    }

    const envelope = job.data as JobEnvelope<MediaProbePayload>;
    const payload = envelope.payload;
    const { jobId, attemptId } = envelope;
    const started = Date.now();

    const log = {
      jobId,
      attemptId,
      queue: queueName,
      mediaId: payload.mediaId,
      workspaceId: envelope.workspaceId,
      bullJobId: job.id,
      attempt: job.attemptsMade + 1,
    };
    logger.info("job received", log);

    const heartbeat = new Heartbeat(services.callbacks, jobId, attemptId, interval);

    try {
      if (envelope.projectId === undefined || envelope.projectId === "") {
        // Every CONTRACTS §6 key is scoped by project, so a media job without one
        // has nowhere to write. That is a producer bug, not a transient fault.
        throw new MediaJobError(
          "media/no_project",
          "This media job carries no projectId, so no CONTRACTS §6 key can be built.",
          { retryable: false, reason: "media/probe_failed" },
        );
      }
      const derivedPrefix = mediaPrefix(envelope.workspaceId, envelope.projectId, payload.mediaId);

      await heartbeat.postNow(0, `${queueName} started`);
      heartbeat.start();

      const outcome = await processor({
        settings: services.settings,
        envelope,
        payload,
        derivedPrefix,
        raw: services.raw,
        derived: services.derived,
        callbacks: services.callbacks,
        report: (progress, message) => {
          heartbeat.report(progress, message);
        },
        signal: shutdown,
      });

      heartbeat.stop();

      // The measured facts go in BEFORE the completion, so the row is already
      // right when the completion handler enqueues the next job off it.
      if (outcome.mediaPatch !== undefined) {
        await services.callbacks.patchMedia(payload.mediaId, attemptId, outcome.mediaPatch);
      }

      const ack = await services.callbacks.complete(jobId, attemptId, {
        status: "succeeded",
        result: outcome.result,
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      });

      logger.info("job succeeded", { ...log, ms: Date.now() - started, applied: ack.applied });
      await job.updateProgress(100);
      return outcome.result;
    } catch (error) {
      heartbeat.stop();
      await reportFailure(job, error, { services, envelope, log, started });
      throw error;
    }
  };
}

/** The failure half of the retry table. Never throws on its own account. */
async function reportFailure(
  job: Job,
  error: unknown,
  input: {
    readonly services: Services;
    readonly envelope: JobEnvelope<MediaProbePayload>;
    readonly log: Record<string, unknown>;
    readonly started: number;
  },
): Promise<void> {
  const { services, envelope, log } = input;
  const failure = error instanceof MediaJobError ? error : null;
  const retryable = failure?.retryable ?? true;
  const attempts = job.opts.attempts ?? 1;
  const finalAttempt = job.attemptsMade + 1 >= attempts;
  const terminal = !retryable || finalAttempt;

  logger.error("job failed", {
    ...log,
    ms: Date.now() - input.started,
    retryable,
    finalAttempt,
    code: failure?.code ?? "media/unknown",
    error: describeError(error),
    ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
  });

  if (!terminal) return;

  // Terminal: the user is told, once, and in the closed vocabulary the API's
  // allow-list accepts.
  const reason: MediaFailureReason = failure?.reason ?? "media/probe_failed";
  await services.callbacks
    .patchMedia(envelope.payload.mediaId, envelope.attemptId, {
      status: "failed",
      failureReason: reason,
    })
    .catch((patchError: unknown) => {
      logger.error("could not mark the media asset failed", {
        ...log,
        error: describeError(patchError),
      });
    });

  await services.callbacks
    .complete(envelope.jobId, envelope.attemptId, {
      status: "failed",
      error: {
        code: failure?.code ?? "media/failed",
        // The ffmpeg tail rides on the message so an operator sees it in
        // `jobs.error`; `errors.ts` has already redacted the signed URL out of it.
        message: [describeError(error), failure?.detail].filter(Boolean).join("\n").slice(0, 2_000),
        retryable,
      },
      finalAttempt,
    })
    .catch((completeError: unknown) => {
      logger.error("could not report the failure", {
        ...log,
        error: describeError(completeError),
      });
    });
}
