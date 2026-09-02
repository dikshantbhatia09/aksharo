/**
 * Signed worker → API callbacks (`docs/CONTRACTS.md` §3), the TypeScript twin of
 * `apps/worker-ai/worker_ai/callbacks.py`.
 *
 * ```
 * POST {API_ORIGIN}/internal/jobs/{jobId}/progress  {progress, etaMs?, message?}
 * POST {API_ORIGIN}/internal/jobs/{jobId}/complete  {status, result?, error?, usage?}
 *
 * X-Montaj-Attempt:   <attemptId>
 * X-Montaj-Timestamp: <unix seconds>
 * X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
 * ```
 *
 * Three things matter and all three are easy to get wrong:
 *
 * 1. **The signature covers the exact bytes that go on the wire.** This module
 *    serialises once, signs those bytes and posts those same bytes — never a
 *    re-encoding, because `JSON.stringify` and `json.dumps` disagree on
 *    separators and a re-serialised body would pass every test and fail in
 *    production.
 * 2. **The worker signs with the primary secret only.**
 *    `INTERNAL_CALLBACK_SECRET_NEXT` is the API's *verification* key during a
 *    rotation; a worker is rolled onto the new secret by restarting it with a new
 *    `INTERNAL_CALLBACK_SECRET`.
 * 3. **Delivery is at-least-once.** Retries are safe because the API is
 *    idempotent on `(jobId, attemptId)`: a replay answers 200 with
 *    `applied: false`, which this client reports rather than treating as failure.
 *
 * `X-Montaj-*` uses the engineering codename, which is correct for a wire header
 * (CONTRACTS §0 covers user-visible strings).
 */

import { createHmac } from "node:crypto";

export const ATTEMPT_HEADER = "x-montaj-attempt";
export const TIMESTAMP_HEADER = "x-montaj-timestamp";
export const SIGNATURE_HEADER = "x-montaj-signature";

/** The API rejects anything outside five minutes either side (CONTRACTS §3). */
export const SIGNATURE_SKEW_MS = 5 * 60_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = 500;

/** `usage` on the completion body — what the job actually consumed. */
export interface JobUsage {
  readonly mediaSeconds?: number;
  readonly outputSeconds?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly costMinor?: number;
  readonly egressBytes?: number;
  readonly actualTenths?: number;
}

/** `error` on a failed completion. `retryable: false` dead-letters the job. */
export interface JobError {
  readonly code: string;
  readonly message: string;
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

/** The API's reply. `applied: false` is a replay, which is a success. */
export interface CallbackAck {
  readonly applied: boolean;
  readonly jobId: string;
  readonly status: string;
  readonly reason?: string;
}

export class CallbackError extends Error {
  public override readonly name = "CallbackError";
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

/** `hex(hmac_sha256(secret, timestamp + "." + body))`. */
export function signRequest(secret: string, timestamp: number | string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${String(timestamp)}.`);
  hmac.update(body, "utf8");
  return hmac.digest("hex");
}

/** Headers a signed internal request needs. */
export function signatureHeaders(input: {
  readonly secret: string;
  readonly attemptId: string;
  readonly body: string;
  readonly now?: number;
}): Record<string, string> {
  const timestamp = Math.floor((input.now ?? Date.now()) / 1000);
  return {
    "content-type": "application/json",
    [ATTEMPT_HEADER]: input.attemptId,
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: signRequest(input.secret, timestamp, input.body),
  };
}

/** Drops undefined fields and rounds the floats, matching the Python client. */
export function encodeUsage(usage: JobUsage): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (usage.mediaSeconds !== undefined) wire["mediaSeconds"] = round3(usage.mediaSeconds);
  if (usage.outputSeconds !== undefined) wire["outputSeconds"] = round3(usage.outputSeconds);
  if (usage.provider !== undefined) wire["provider"] = usage.provider;
  if (usage.model !== undefined) wire["model"] = usage.model;
  if (usage.costMinor !== undefined) wire["costMinor"] = Math.trunc(usage.costMinor);
  if (usage.egressBytes !== undefined) wire["egressBytes"] = Math.trunc(usage.egressBytes);
  if (usage.actualTenths !== undefined) wire["actualTenths"] = Math.trunc(usage.actualTenths);
  return wire;
}

/** The completion body of CONTRACTS §3, with every unset field omitted. */
export function encodeCompletion(completion: JobCompletion): Record<string, unknown> {
  const wire: Record<string, unknown> = { status: completion.status };
  if (completion.result !== undefined) wire["result"] = completion.result;
  if (completion.error !== undefined) {
    wire["error"] = {
      code: completion.error.code.slice(0, 128),
      message: completion.error.message.slice(0, 2_000) || "failed",
      retryable: completion.error.retryable,
    };
  }
  if (completion.usage !== undefined) {
    const usage = encodeUsage(completion.usage);
    if (Object.keys(usage).length > 0) wire["usage"] = usage;
  }
  if (completion.finalAttempt !== undefined) wire["finalAttempt"] = completion.finalAttempt;
  return wire;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Injected so tests need no network and no `vi.stubGlobal`. */
export type FetchLike = (
  url: string,
  init: { method: string; body: string; headers: Record<string, string> },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface CallbackClientOptions {
  readonly apiOrigin: string;
  readonly secret: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  /** Injected so a retry test does not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so the jitter is deterministic in a test. */
  readonly random?: () => number;
}

/**
 * Posts signed progress and completion callbacks with bounded retries.
 *
 * Retries cover the transport and the API's 5xx and 429 only. A 4xx is a
 * contract error — a bad signature, an unknown job, a body the schema rejects —
 * and retrying it would just burn the five-minute signature window.
 */
export class CallbackClient {
  readonly #origin: string;
  readonly #secret: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: CallbackClientOptions) {
    if (options.secret === "") {
      throw new Error("INTERNAL_CALLBACK_SECRET is required to sign callbacks");
    }
    this.#origin = options.apiOrigin.replace(/\/+$/, "");
    this.#secret = options.secret;
    this.#fetch = options.fetch ?? defaultFetch(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = options.random ?? Math.random;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /** `POST /internal/jobs/{jobId}/progress`. Also flips the row to running. */
  async progress(
    jobId: string,
    attemptId: string,
    progress: number,
    extra: { etaMs?: number; message?: string } = {},
  ): Promise<CallbackAck> {
    const body: Record<string, unknown> = {
      progress: Math.max(0, Math.min(100, Math.round(progress * 100) / 100)),
    };
    if (extra.etaMs !== undefined) body["etaMs"] = Math.max(0, Math.trunc(extra.etaMs));
    if (extra.message !== undefined) body["message"] = extra.message.slice(0, 1_000);
    return this.#post(`/internal/jobs/${jobId}/progress`, attemptId, body);
  }

  /** `POST /internal/jobs/{jobId}/complete`. Safe to replay. */
  async complete(
    jobId: string,
    attemptId: string,
    completion: JobCompletion,
  ): Promise<CallbackAck> {
    return this.#post(`/internal/jobs/${jobId}/complete`, attemptId, encodeCompletion(completion));
  }

  async #post(
    path: string,
    attemptId: string,
    payload: Record<string, unknown>,
  ): Promise<CallbackAck> {
    const body = JSON.stringify(payload);
    const url = `${this.#origin}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      // Re-signed per attempt: a retry after a long backoff must not carry a
      // timestamp the API has already aged out of its five-minute window.
      const headers = signatureHeaders({ secret: this.#secret, attemptId, body });
      let response: { status: number; text: () => Promise<string> } | undefined;
      try {
        response = await this.#fetch(url, { method: "POST", body, headers });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (response !== undefined) {
        if (response.status < 400) return await readAck(response);
        if (response.status < 500 && response.status !== 429) {
          throw new CallbackError(
            `${path} rejected with ${String(response.status)}`,
            response.status,
          );
        }
        lastError = new CallbackError(
          `${path} answered ${String(response.status)}`,
          response.status,
        );
      }

      if (attempt < this.#maxAttempts) await this.#sleep(this.#delayFor(attempt));
    }

    throw new CallbackError(
      `${path} failed after ${String(this.#maxAttempts)} attempts: ${lastError?.message ?? "unknown"}`,
    );
  }

  /** Exponential backoff with jitter, capped inside the signature window. */
  #delayFor(attempt: number): number {
    const base = Math.min(this.#backoffMs * 2 ** (attempt - 1), 30_000);
    // Jitter spreads retries across workers; it is not a security value.
    return base * (0.5 + this.#random() / 2);
  }
}

async function readAck(response: {
  status: number;
  text: () => Promise<string>;
}): Promise<CallbackAck> {
  let parsed: Record<string, unknown> = {};
  try {
    const text = await response.text();
    const value: unknown = text === "" ? {} : JSON.parse(text);
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const reason = parsed["reason"];
  return {
    applied: parsed["applied"] !== false,
    jobId: typeof parsed["jobId"] === "string" ? parsed["jobId"] : "",
    status: typeof parsed["status"] === "string" ? parsed["status"] : "",
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function defaultFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { status: response.status, text: () => response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}
