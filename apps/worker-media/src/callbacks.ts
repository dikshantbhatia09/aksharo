import { createHmac } from "node:crypto";

import { describeError } from "./errors.js";
import { logger } from "./logger.js";

/**
 * Signed worker → API callbacks (`docs/CONTRACTS.md` §3).
 *
 * ```
 * POST {API_ORIGIN}/internal/jobs/{jobId}/progress  {progress, etaMs?, message?}
 * POST {API_ORIGIN}/internal/jobs/{jobId}/complete  {status, result?, error?, usage?}
 * PATCH {API_ORIGIN}/internal/media/{mediaId}       <allow-listed fields>
 *
 * X-Montaj-Attempt:   <attemptId>
 * X-Montaj-Timestamp: <unix seconds>
 * X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
 * ```
 *
 * The TypeScript twin of `apps/worker-ai/worker_ai/callbacks.py`, and it makes
 * the same three commitments:
 *
 * 1. **The signature covers the exact bytes that go on the wire.** The body is
 *    serialised once, signed, and posted — never re-encoded. The API verifies
 *    against `request.rawBody` for precisely this reason
 *    (`internal-signature.ts`), and `JSON.stringify` twice is not guaranteed to
 *    produce the same string when a value is a `Map`, a `Date` or anything with a
 *    `toJSON`.
 * 2. **The worker signs with the primary secret only.** `INTERNAL_CALLBACK_SECRET_NEXT`
 *    is the API's *verification* key during a rotation; a worker is rolled onto a
 *    new secret by restarting it with a new `INTERNAL_CALLBACK_SECRET`.
 * 3. **Delivery is at-least-once and retries are safe**, because the API is
 *    idempotent on `(jobId, attemptId)`: a replay answers 200 with
 *    `applied: false`, which this client reports rather than treating as failure.
 *
 * `X-Montaj-*` uses the engineering codename, which is correct for a wire header
 * (CONTRACTS §0 covers user-visible strings).
 */

export const ATTEMPT_HEADER = "x-montaj-attempt";
export const TIMESTAMP_HEADER = "x-montaj-timestamp";
export const SIGNATURE_HEADER = "x-montaj-signature";

/** The API rejects anything outside five minutes either side (CONTRACTS §3). */
export const SIGNATURE_SKEW_MS = 5 * 60_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = 500;
/** The longest wait between two tries, well inside the five-minute signature window. */
const MAX_BACKOFF_MS = 15_000;

/**
 * How long a completion or a media write-back keeps trying while the API is
 * not there to answer: a transport failure, or one of {@link UNAVAILABLE_STATUSES}.
 *
 * Four tries over about three seconds (the budget progress keeps) is shorter
 * than a routine API restart — ten to fifteen seconds here, through the tunnel —
 * and losing one of these is not like losing a heartbeat. A dropped failure
 * left the job `running` and the run spinning with nothing left to move it; a
 * dropped success threw into the retry path and BullMQ downloaded, encoded or
 * cut the whole thing again. Two minutes covers a restart with room over, and
 * is still well inside every media queue's lock.
 */
export const DURABLE_CALLBACK_BUDGET_MS = 2 * 60_000;

/**
 * The answers that mean the API itself did not answer: a gateway or the tunnel
 * speaking for it while it restarts (502/503/504, and Cloudflare's own
 * 520-524 and 530 when the tunnel has no origin), or a rate limit (429).
 *
 * A plain 500 is not on the list. That is the API up and a completion handler
 * throwing, which it will do again in two minutes: given the durable budget,
 * each BullMQ attempt held the single acquire slot for two minutes and re-drove
 * the failing handler ten times. It gets the few tries progress gets, and goes
 * back to BullMQ's retry — the path the API's 500 is asking for.
 */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([
  429, 502, 503, 504, 520, 521, 522, 523, 524, 530,
]);

/** `hex(hmac_sha256(secret, timestamp + "." + body))`. */
export function signInternalRequest(input: {
  readonly secret: string;
  readonly timestamp: number | string;
  readonly body: string | Buffer;
}): string {
  const hmac = createHmac("sha256", input.secret);
  hmac.update(`${String(input.timestamp)}.`);
  hmac.update(input.body);
  return hmac.digest("hex");
}

/** Headers a signed internal request needs, ready to hand to `fetch`. */
export function internalSignatureHeaders(input: {
  readonly secret: string;
  readonly attemptId: string;
  readonly body: string | Buffer;
  readonly now?: number;
}): Record<string, string> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  return {
    "content-type": "application/json",
    [ATTEMPT_HEADER]: input.attemptId,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signInternalRequest({
      secret: input.secret,
      timestamp,
      body: input.body,
    }),
  };
}

/** What the job actually consumed (CONTRACTS §3 `usage`). */
export interface JobUsage {
  readonly mediaSeconds?: number;
  readonly outputSeconds?: number;
  readonly egressBytes?: number;
  readonly actualTenths?: number;
}

export interface JobError {
  readonly code: string;
  readonly message: string;
  /** `false` sends the job straight to the dead-letter path (A08b). */
  readonly retryable: boolean;
}

export interface JobCompletion {
  readonly status: "succeeded" | "failed";
  readonly result?: Record<string, unknown>;
  readonly error?: JobError;
  readonly usage?: JobUsage;
  /** True when BullMQ has no attempts left; A08b reads it to fill the DLQ table. */
  readonly finalAttempt?: boolean;
}

/** The API's reply, shared by both callbacks. */
export interface CallbackAck {
  /** `false` for a replay or a superseded attempt — a success, from here. */
  readonly applied: boolean;
  readonly jobId: string;
  readonly status: string;
  readonly reason?: string;
}

/** The API refused a callback, or was unreachable for every attempt. */
export class CallbackError extends Error {
  public override readonly name = "CallbackError";
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export interface CallbackClientOptions {
  readonly timeoutMs?: number;
  /** Tries for a progress post; a durable callback makes at least this many. */
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  /** See {@link DURABLE_CALLBACK_BUDGET_MS}. */
  readonly durableBudgetMs?: number;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Posts signed callbacks, with bounded retries.
 *
 * Retries cover the transport, 5xx and 429 only. A 4xx is a contract error — a
 * bad signature, an unknown job, a body the API's schema rejects — and retrying
 * it would only burn the five-minute signature window.
 *
 * Two budgets. Progress is a heartbeat: `maxAttempts` tries and give up, because
 * the next beat will carry the news. A completion and a media write-back are
 * **durable**: while the API is unreachable they keep trying for
 * {@link DURABLE_CALLBACK_BUDGET_MS}, because nothing else will ever deliver
 * them. A 500 gets the short budget either way (see {@link UNAVAILABLE_STATUSES}).
 */
export class CallbackClient {
  private readonly origin: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly durableBudgetMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(apiOrigin: string, secret: string, options: CallbackClientOptions = {}) {
    // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
    if (secret === "") {
      throw new Error("INTERNAL_CALLBACK_SECRET is required to sign callbacks");
    }
    this.origin = apiOrigin.replace(/\/+$/, "");
    this.secret = secret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.durableBudgetMs = options.durableBudgetMs ?? DURABLE_CALLBACK_BUDGET_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** `POST /internal/jobs/{jobId}/progress`. Also flips the row to `running`. */
  async progress(
    jobId: string,
    attemptId: string,
    progress: number,
    extra: { readonly etaMs?: number; readonly message?: string } = {},
  ): Promise<CallbackAck> {
    const body: Record<string, unknown> = {
      progress: Math.max(0, Math.min(100, Math.round(progress * 100) / 100)),
      ...(extra.etaMs === undefined ? {} : { etaMs: Math.max(0, Math.round(extra.etaMs)) }),
      ...(extra.message === undefined ? {} : { message: extra.message.slice(0, 1_000) }),
    };
    return this.send("POST", `/internal/jobs/${jobId}/progress`, attemptId, body, false);
  }

  /** `POST /internal/jobs/{jobId}/complete`. Safe to replay, and durable. */
  async complete(
    jobId: string,
    attemptId: string,
    completion: JobCompletion,
  ): Promise<CallbackAck> {
    return this.send(
      "POST",
      `/internal/jobs/${jobId}/complete`,
      attemptId,
      { ...completion } as Record<string, unknown>,
      true,
    );
  }

  /**
   * `PATCH /internal/media/{mediaId}` — the allow-listed write-back.
   *
   * The worker never touches the database; this is the only way a measured fact
   * reaches `media_assets`, and the API decides which fields it will accept.
   * Durable, like a completion: it carries the measured facts a success needs
   * and the failure reason a user is shown.
   */
  async patchMedia(
    mediaId: string,
    attemptId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.send("PATCH", `/internal/media/${mediaId}`, attemptId, patch, true);
  }

  private async send(
    method: "POST" | "PATCH",
    path: string,
    attemptId: string,
    payload: Record<string, unknown>,
    durable: boolean,
  ): Promise<CallbackAck> {
    // Serialised ONCE. The bytes below are the bytes that are signed and the bytes
    // that are sent; the API verifies against exactly them.
    const body = JSON.stringify(payload);
    const url = `${this.origin}${path}`;
    const started = Date.now();
    let last: unknown = null;
    let attempt = 0;
    // Whether the latest try found nobody there, rather than an API that answered.
    let unavailable = false;

    for (;;) {
      attempt += 1;
      // Re-signed per attempt: a retry after a long backoff must not carry a
      // timestamp the API has already aged out of its five-minute window.
      const headers = internalSignatureHeaders({ secret: this.secret, attemptId, body });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(url, {
          method,
          body,
          headers,
          signal: controller.signal,
        });
        if (response.status < 400) return await readAck(response);
        if (response.status < 500 && response.status !== 429) {
          throw new CallbackError(
            `${path} rejected with ${String(response.status)}`,
            response.status,
          );
        }
        last = new CallbackError(`${path} answered ${String(response.status)}`, response.status);
        unavailable = UNAVAILABLE_STATUSES.has(response.status);
        logger.warn("callback rejected, will retry", {
          path,
          attempt,
          status: response.status,
        });
      } catch (error) {
        if (error instanceof CallbackError && error.statusCode !== undefined) throw error;
        last = error;
        unavailable = true;
        logger.warn("callback transport failure", { path, attempt, error: describeError(error) });
      } finally {
        clearTimeout(timer);
      }

      const delay = this.delayFor(attempt);
      const withinBudget =
        durable && unavailable && Date.now() - started + delay <= this.durableBudgetMs;
      if (attempt >= this.maxAttempts && !withinBudget) break;
      await sleep(delay);
    }

    throw new CallbackError(
      `${path} failed after ${String(attempt)} attempts: ${describeError(last)}`,
    );
  }

  /** Exponential backoff with jitter, capped well inside the signature window. */
  private delayFor(attempt: number): number {
    const base = Math.min(this.backoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    // Jitter spreads retries across workers; it is not a security value.
    return base * (0.5 + Math.random() / 2);
  }
}

async function readAck(response: Response): Promise<CallbackAck> {
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const body = typeof parsed === "object" && parsed !== null ? parsed : {};
  return {
    applied: body["applied"] !== false,
    jobId: typeof body["jobId"] === "string" ? body["jobId"] : "",
    status: typeof body["status"] === "string" ? body["status"] : "",
    ...(typeof body["reason"] === "string" ? { reason: body["reason"] } : {}),
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
