import { UnrecoverableError } from "bullmq";

import { CallbackClient, CallbackError } from "./callbacks.js";
import { MediaJobError, describeError, transientFailure } from "./errors.js";
import { logger } from "./logger.js";
import { heartbeatIntervalMs } from "./policies.js";
import { MEDIA_ACQUIRE_QUEUE, isJobEnvelope, isMediaPayload } from "./queues.js";
import { mediaPrefix } from "./storage-keys.js";
import { storesFrom } from "./storage.js";

import type { CallbackAck, JobCompletion, JobUsage } from "./callbacks.js";
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
 * | Failure                     | Completion posted?           | Exception re-raised?          |
 * | --------------------------- | ---------------------------- | ----------------------------- |
 * | retryable, attempts remain  | **no**                       | yes — BullMQ retries          |
 * | retryable, final attempt    | yes, `finalAttempt: true`    | yes — BullMQ fails            |
 * | non-retryable (any attempt) | yes, `error.retryable:false` | as `UnrecoverableError`       |
 * | envelope does not parse     | no (there is no jobId)       | as `UnrecoverableError`       |
 * | API says the row is settled | no (it would be refused)     | as `UnrecoverableError`       |
 * | outcome the API never heard | carried to the next attempt  | yes, retryable (see below)    |
 *
 * `finalAttempt` and `error.retryable === false` are exactly the two flags
 * `markDeadLetterIfFinal` reads, so a job that has run out of road lands in the
 * dead-letter queue with its last error attached.
 *
 * **`UnrecoverableError` is what makes "non-retryable" true.** BullMQ does not
 * read our flag; it retries anything thrown until the attempts run out, unless
 * the error is its own `UnrecoverableError`. Rethrowing the `MediaJobError`
 * itself meant a video over the plan's size cap was downloaded three times, and
 * the second and third completions were refused as `already_completed`.
 *
 * A callback the API **refused** (4xx) is non-retryable too: re-running the
 * processor re-downloads or re-encodes everything only to be refused again.
 *
 * **An outcome the API never heard is carried, not dropped and not redone.** A
 * callback it could not reach has already been retried for the durable budget
 * (`callbacks.ts`); if it still has not landed, the exact bodies go into the
 * BullMQ job's own data (`pendingOutcome`) and the attempt fails retryably. The
 * next attempt delivers them and runs nothing. Without this, a success lost to
 * a slow API restart downloaded the whole video again, and a lost failure left
 * the job `running` and the run spinning, with no sweep in production to
 * rescue it — converting that failure to `UnrecoverableError` would have made
 * the loss permanent. A carried outcome is tied to its `attemptId`, so a DLQ
 * replay (which mints a new one) runs afresh.
 *
 * **The media row is only marked `failed` when the failure is terminal.** An asset
 * shown as failed while BullMQ still has two attempts left is a lie the next
 * attempt has to undo, and the user has watched it happen.
 *
 * **A row settled mid-run stops the work** — the table's settled row, at any
 * point after pickup rather than only at it. Stopping a run cancels its jobs
 * in the API, but BullMQ cannot remove a job a worker holds, so a download
 * already under way used to run to its end — up to the 40-minute acquire
 * timeout, on the one acquisition slot every run shares — and then upload a
 * file nobody would keep. Every progress answer after the stop says
 * `already_completed`, so the heartbeat reads its answers: a settled one
 * aborts the job's own signal (the processor's `signal` is that one joined
 * with the shutdown's), and the job ends like a settled pickup — nothing
 * reported, nothing retried. A shutdown alone never aborts it, so a job
 * interrupted by a restart still fails retryably and runs again.
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
  /**
   * Aborted when the worker is shutting down, or when the API says this job's
   * row is settled (a stopped run), so ffmpeg or the downloader is killed with it.
   */
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
 * The `reason`s on an `applied: false` ack (`staleReason` in `jobs.service.ts`)
 * that mean nothing this delivery does can be recorded: the row is terminal, or
 * a newer attempt owns it. The same set `worker_ai/runtime.py` stops on.
 */
const SETTLED_REASONS: ReadonlySet<string> = new Set(["already_completed", "stale_attempt"]);

/** The reason an ack says nothing more can be recorded, or `null` when it can. */
function settledReason(ack: CallbackAck): string | null {
  return !ack.applied && ack.reason !== undefined && SETTLED_REASONS.has(ack.reason)
    ? ack.reason
    : null;
}

/** A move this large is news, and is posted before the heartbeat interval is up... */
export const PROGRESS_STEP = 5;
/** ...but never sooner than this after the previous post, whatever the processor says. */
export const MIN_PROGRESS_POST_MS = 2_000;

/**
 * Post progress at most once per `intervalMs` — or sooner when it has moved by
 * {@link PROGRESS_STEP} points — and always for 0 and 100.
 *
 * The progress callback is *also* the API-side heartbeat
 * (`JobsService.recordProgress` promotes a `queued` job to `running`), so a long
 * encode that has nothing new to say still has to call it — hence
 * {@link Heartbeat.start}, which re-posts the last known percentage on a timer
 * even when the processor has gone quiet inside one ffmpeg run.
 *
 * The step rule exists because the interval is a third of the lock — 200 s on
 * the media queues — and a 90-second download that posted only on the interval
 * showed "getting your video" at 5% from start to finish.
 *
 * Every answer is read as well as sent: one that says the row is settled is
 * how a running job learns its run was stopped (see `onSettled`). A download
 * that is moving posts every few points, so that is usually seconds; a stalled
 * one, or a quiet encode, learns it at worst one interval later.
 */
export class Heartbeat {
  private last = -1;
  private lastPosted = -1;
  private lastPostedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  /** The post on the wire, if any, settled or not; see {@link Heartbeat.drain}. */
  private inflight: Promise<void> | undefined;
  private settled = false;

  constructor(
    private readonly callbacks: CallbackClient,
    private readonly jobId: string,
    private readonly attemptId: string,
    private readonly intervalMs: number,
    /**
     * Called once, when an answer says the row is settled — a user stopped the
     * run, or a newer attempt owns the row — so nothing this attempt does can
     * be recorded any more. Nothing is posted after it.
     */
    private readonly onSettled?: (reason: string) => void,
  ) {}

  /** Note a new percentage, and post it if enough time has passed or it moved enough. */
  report(progress: number, message?: string): void {
    this.last = progress;
    const elapsed = Date.now() - this.lastPostedAt;
    const moved = progress - this.lastPosted >= PROGRESS_STEP && elapsed >= MIN_PROGRESS_POST_MS;
    if (elapsed < this.intervalMs && !moved) return;
    this.post(progress, message);
  }

  /** Post immediately, whatever the throttle says. For 0 and 100. */
  async postNow(progress: number, message?: string): Promise<CallbackAck> {
    this.last = progress;
    this.lastPosted = progress;
    this.lastPostedAt = Date.now();
    return this.callbacks.progress(this.jobId, this.attemptId, progress, {
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

  /**
   * Wait out a post already on the wire; never rejects.
   *
   * `stop()` only ends the timer. A beat sent just before the processor
   * returned can still come back saying the row is settled, and a caller that
   * checked for that without waiting would deliver this attempt's media patch
   * anyway — the API checks the completion against the job, not the patch.
   * Bounded by the progress post's own short retry budget.
   */
  async drain(): Promise<void> {
    await this.inflight;
  }

  private post(progress: number, message?: string): void {
    if (this.inflight !== undefined || this.settled) return;
    this.lastPosted = progress;
    this.lastPostedAt = Date.now();
    this.inflight = this.callbacks
      .progress(this.jobId, this.attemptId, progress, {
        ...(message === undefined ? {} : { message }),
      })
      .then((ack) => {
        const reason = settledReason(ack);
        if (reason === null || this.settled) return;
        this.settled = true;
        this.stop();
        this.onSettled?.(reason);
      })
      .catch((error: unknown) => {
        // A dropped heartbeat is not a reason to fail work that is going fine: the
        // BullMQ lock is renewed separately, and the next beat will land.
        logger.warn("heartbeat not delivered", { jobId: this.jobId, error: describeError(error) });
      })
      .finally(() => {
        this.inflight = undefined;
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
      throw new UnrecoverableError(
        `Job ${job.id ?? "?"} on ${job.queueName} does not match the CONTRACTS §3 envelope.`,
      );
    }

    const envelope = job.data as JobEnvelope<MediaProbePayload>;
    const payload = envelope.payload;
    const { jobId, attemptId } = envelope;
    const started = Date.now();

    const targetId =
      payload.mediaId ??
      ((payload as unknown as Record<string, unknown>)["clipId"] as string) ??
      "";
    const log = {
      jobId,
      attemptId,
      queue: queueName,
      mediaId: targetId,
      workspaceId: envelope.workspaceId,
      bullJobId: job.id,
      attempt: job.attemptsMade + 1,
    };
    logger.info("job received", log);

    // This job's own stop, separate from the process's: aborted only when the
    // API says the row is settled, so it can be told apart from a shutdown,
    // which has to stay retryable.
    const settled = new AbortController();
    const heartbeat = new Heartbeat(services.callbacks, jobId, attemptId, interval, (reason) => {
      logger.warn("job was settled by the API while it ran; stopping it", { ...log, reason });
      settled.abort(reason);
    });
    const alreadySettled = (reason: unknown): UnrecoverableError =>
      new UnrecoverableError(`${queueName} job ${jobId} is already settled (${String(reason)})`);
    const reporting: Reporting = { services, envelope, log, started, queueName };

    // An earlier attempt finished and could not tell the API. Tell it now,
    // rather than downloading or encoding everything again for the same answer.
    const carried = carriedOutcome(job.data, attemptId);
    if (carried?.completion.status === "failed") {
      return deliverCarriedFailure(job, carried, reporting);
    }

    try {
      if (carried !== undefined) {
        logger.info("delivering the result an earlier attempt could not report", log);
      }
      const success = carried ?? (await runProcessor());
      const ack = await deliverSuccess(job, success, reporting);
      logger.info("job succeeded", { ...log, ms: Date.now() - started, applied: ack.applied });
      await job.updateProgress(100);
      return success.completion.result ?? {};
    } catch (thrown) {
      heartbeat.stop();
      // A beat on the wire may be the one that says the run was stopped; the
      // failure report below would mark the media failed over a stopped run.
      await heartbeat.drain();
      // Only the settled-row refusal throws this: there is nothing to report
      // against a row the API has closed, and nothing to retry.
      if (thrown instanceof UnrecoverableError) throw thrown;
      // The row was settled while the processor ran, and it was stopped for
      // that (or failed on its own at the same moment). Either way the API
      // would refuse the report — the row's own failure is the user's answer —
      // and a retry would only be turned away at pickup.
      if (settled.signal.aborted) throw alreadySettled(settled.signal.reason);
      const error = asMediaJobError(thrown);
      const unheard = await reportFailure(job, error, reporting);
      if (unheard !== null && (await carryToNextAttempt(job, unheard, log))) {
        // Ending the job here would leave its row `running` for good.
        throw transientFailure(
          "worker/outcome_undelivered",
          "the API could not be told this job failed; the next attempt will tell it",
          { cause: error },
        );
      }
      if (error instanceof MediaJobError && !error.retryable) {
        // After the report, so the user is told why even though BullMQ is not.
        const unrecoverable = new UnrecoverableError(
          error.message || `${queueName} failed and will not be retried`,
        );
        unrecoverable.cause = error;
        throw unrecoverable;
      }
      throw error;
    }

    /** Pick the job up, run the processor, and shape what it made for delivery. */
    async function runProcessor(): Promise<PendingOutcome> {
      if (envelope.projectId === undefined || envelope.projectId === "") {
        // Every CONTRACTS §6 key is scoped by project, so a media job without one
        // has nowhere to write. That is a producer bug, not a transient fault.
        throw new MediaJobError(
          "media/no_project",
          "This media job carries no projectId, so no CONTRACTS §6 key can be built.",
          { retryable: false, reason: "media/probe_failed" },
        );
      }
      const derivedPrefix = mediaPrefix(envelope.workspaceId, envelope.projectId, targetId);

      const pickup = await heartbeat.postNow(0, `${queueName} started`);
      const pickupSettled = settledReason(pickup);
      if (pickupSettled !== null) {
        // Nothing this attempt does can be recorded — a user cancelled the run,
        // or an earlier attempt already settled the row — and for acquisition
        // running anyway means downloading a whole video nobody will keep.
        logger.warn("job is already settled by the API; not running it", {
          ...log,
          reason: pickupSettled,
        });
        throw alreadySettled(pickupSettled);
      }
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
        // Either stop kills a child process that is running. One not yet spawned
        // needs its own check of the signal: the downloader and acquire make
        // one, ffmpeg/run.ts does not yet, so a stop between two ffmpeg steps
        // lets the next run to its end before delivery is refused. Only the
        // shutdown is retried.
        signal: AbortSignal.any([shutdown, settled.signal]),
      });

      heartbeat.stop();
      // Settled while the last step finished anyway: the completion would be
      // refused, and the media patch — which the API does not check against the
      // job — would still write this attempt's facts onto the asset. The check
      // waits for a beat still on the wire, whose answer may be that stop.
      await heartbeat.drain();
      if (settled.signal.aborted) throw alreadySettled(settled.signal.reason);

      return {
        attemptId,
        ...(outcome.mediaPatch !== undefined && payload.mediaId !== undefined
          ? { mediaPatch: outcome.mediaPatch }
          : {}),
        completion: {
          status: "succeeded",
          result: outcome.result,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        },
      };
    }
  };
}

/** What the failure path needs to know about the job it is reporting. */
interface Reporting {
  readonly services: Services;
  readonly envelope: JobEnvelope<MediaProbePayload>;
  readonly log: Record<string, unknown>;
  readonly started: number;
  readonly queueName: string;
}

/**
 * An outcome as the API will receive it: the exact bodies, so an attempt that
 * delivers a carried one sends what the attempt that made it would have.
 */
interface PendingOutcome {
  /** The row's attempt. A job replayed under a new one must not deliver an old answer. */
  readonly attemptId: string;
  /** `PATCH /internal/media/{mediaId}`, sent first. */
  readonly mediaPatch?: Record<string, unknown>;
  readonly completion: JobCompletion;
}

/** The outcome an earlier attempt of THIS row left undelivered, if any. */
function carriedOutcome(data: unknown, attemptId: string): PendingOutcome | undefined {
  // Where `carryToNextAttempt` puts it, next to the envelope's own fields.
  const value = (data as { readonly pendingOutcome?: unknown }).pendingOutcome;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<PendingOutcome>;
  const status = candidate.completion?.status;
  if (candidate.attemptId !== attemptId || (status !== "succeeded" && status !== "failed")) {
    return undefined;
  }
  return candidate as PendingOutcome;
}

function hasAttemptsLeft(job: Job): boolean {
  return job.attemptsMade + 1 < (job.opts.attempts ?? 1);
}

/**
 * Keep an undelivered outcome in the job's data for the next attempt.
 *
 * False when there is no next attempt, or Redis would not take it — and then
 * the caller ends the job the way it always did.
 */
async function carryToNextAttempt(
  job: Job,
  outcome: PendingOutcome,
  log: Record<string, unknown>,
): Promise<boolean> {
  if (!hasAttemptsLeft(job)) return false;
  try {
    await job.updateData({ ...(job.data as Record<string, unknown>), pendingOutcome: outcome });
  } catch (error) {
    logger.error("could not keep the outcome for the next attempt", {
      ...log,
      error: describeError(error),
    });
    return false;
  }
  logger.warn("the API did not hear this job's outcome; the next attempt will deliver it", {
    ...log,
    status: outcome.completion.status,
  });
  return true;
}

/** A callback the API read and said no to: sending it again gets the same answer. */
function wasRefused(error: unknown): boolean {
  return asMediaJobError(error) !== error;
}

/**
 * Deliver a success: the measured facts first, so the row is already right when
 * the completion handler enqueues the next job off it, then the completion.
 *
 * Throws whatever the delivery threw. When the API could not be reached, the
 * outcome is carried first and the throw is retryable, so BullMQ's next attempt
 * delivers it instead of redoing the work.
 */
async function deliverSuccess(
  job: Job,
  success: PendingOutcome,
  input: Reporting,
): Promise<CallbackAck> {
  const { services, envelope } = input;
  try {
    const mediaId = mediaIdOf(envelope);
    if (success.mediaPatch !== undefined && mediaId !== undefined) {
      await services.callbacks.patchMedia(mediaId, envelope.attemptId, success.mediaPatch);
    }
    return await services.callbacks.complete(
      envelope.jobId,
      envelope.attemptId,
      success.completion,
    );
  } catch (error) {
    if (!wasRefused(error) && (await carryToNextAttempt(job, success, input.log))) {
      throw transientFailure(
        "worker/outcome_undelivered",
        "the API could not be told this job succeeded; the next attempt will tell it",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The next attempt of a job whose failure the API never heard: report it, and
 * run nothing. The job is over whatever the answer, unless the API is still
 * unreachable and there is another attempt to try it from.
 */
async function deliverCarriedFailure(
  job: Job,
  carried: PendingOutcome,
  input: Reporting,
): Promise<never> {
  logger.info("reporting the failure an earlier attempt could not; not running the job again", {
    ...input.log,
  });
  // Still carried in the job's data: another attempt needs nothing written.
  if (!(await deliverFailure(carried, input)) && hasAttemptsLeft(job)) {
    throw transientFailure(
      "worker/outcome_undelivered",
      "the API could not be told this job failed; the next attempt will tell it",
    );
  }
  throw new UnrecoverableError(
    // The first line: the rest is the operator's detail, already on the job row.
    carried.completion.error?.message.split("\n")[0] ??
      `${input.queueName} failed and will not be retried`,
  );
}

function mediaIdOf(envelope: JobEnvelope<MediaProbePayload>): string | undefined {
  return (envelope.payload as { readonly mediaId?: string }).mediaId;
}

/**
 * A callback the API refused, as the non-retryable failure it is.
 *
 * Only a 4xx: the API has read the request and said no (an unknown job, a body
 * its schema rejects, a completion handler that will not take this result), and
 * doing all the work again produces the same request. A transport failure or a
 * 5xx has no status here — the client has already retried it, for the durable
 * budget while the API was unreachable — and stays retryable; an outcome it
 * could not deliver is carried to the next attempt (`carryToNextAttempt`).
 */
function asMediaJobError(error: unknown): unknown {
  if (
    !(error instanceof CallbackError) ||
    error.statusCode === undefined ||
    error.statusCode < 400 ||
    error.statusCode >= 500
  ) {
    return error;
  }
  return new MediaJobError("worker/callback_rejected", error.message, {
    retryable: false,
    cause: error,
  });
}

/**
 * The reason a user is shown when a failure brings none of its own.
 *
 * Acquisition's failures are about the source, and "we could not read your file"
 * is the wrong sentence for a link that timed out; every other queue reads a
 * file this product already holds.
 */
function fallbackReason(queueName: string): MediaFailureReason {
  return queueName === MEDIA_ACQUIRE_QUEUE ? "media/source_failed" : "media/probe_failed";
}

/**
 * The failure half of the retry table. Never throws on its own account.
 *
 * Returns the terminal failure when the API could not be reached to hear it,
 * for the caller to carry to the next attempt; `null` when it was heard (or
 * refused, which is as final), or when the failure is not terminal yet.
 */
async function reportFailure(
  job: Job,
  error: unknown,
  input: Reporting,
): Promise<PendingOutcome | null> {
  const { envelope, log } = input;
  const failure = error instanceof MediaJobError ? error : null;
  const retryable = failure?.retryable ?? true;
  const finalAttempt = !hasAttemptsLeft(job);
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

  if (!terminal) return null;

  // Terminal: the user is told, once, and in the closed vocabulary the API's
  // allow-list accepts.
  const reason: MediaFailureReason = failure?.reason ?? fallbackReason(input.queueName);
  const outcome: PendingOutcome = {
    attemptId: envelope.attemptId,
    // A clip job targets a clip, not a media row: there is no asset to mark, and
    // PATCHing `/internal/media/undefined` only earned a 404 in the log.
    ...(mediaIdOf(envelope) === undefined
      ? {}
      : { mediaPatch: { status: "failed", failureReason: reason } }),
    completion: {
      status: "failed",
      error: {
        code: failure?.code ?? "media/failed",
        // The ffmpeg tail rides on the message so an operator sees it in
        // `jobs.error`; `errors.ts` has already redacted the signed URL out of it.
        message: [describeError(error), failure?.detail].filter(Boolean).join("\n").slice(0, 2_000),
        retryable,
      },
      finalAttempt,
    },
  };
  return (await deliverFailure(outcome, input)) ? null : outcome;
}

/**
 * Send a failure: the PATCH first, so the failure handler the completion runs
 * already finds the reason on the row, then the completion — which is sent
 * even when the PATCH was not, because it is what settles the job.
 *
 * True when the API heard the completion, or read it and refused it (sending
 * it again gets the same answer); false when it could not be reached.
 */
async function deliverFailure(outcome: PendingOutcome, input: Reporting): Promise<boolean> {
  const { services, envelope, log } = input;
  const mediaId = mediaIdOf(envelope);
  if (outcome.mediaPatch !== undefined && mediaId !== undefined) {
    await services.callbacks
      .patchMedia(mediaId, envelope.attemptId, outcome.mediaPatch)
      .catch((patchError: unknown) => {
        logger.error("could not mark the media asset failed", {
          ...log,
          error: describeError(patchError),
        });
      });
  }

  try {
    await services.callbacks.complete(envelope.jobId, envelope.attemptId, outcome.completion);
    return true;
  } catch (completeError) {
    logger.error("could not report the failure", { ...log, error: describeError(completeError) });
    return wasRefused(completeError);
  }
}
