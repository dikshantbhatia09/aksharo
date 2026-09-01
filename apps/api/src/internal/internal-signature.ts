import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The worker → API callback signature of `docs/CONTRACTS.md` §3.
 *
 * ```
 * X-Montaj-Attempt:   <attemptId>
 * X-Montaj-Timestamp: <unix seconds>
 * X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
 * ```
 *
 * `body` is the **raw request bytes**, never a re-serialisation: `JSON.stringify`
 * in Node and `json.dumps` in Python disagree on separators and key order, so
 * signing a re-encoded body would work in the test suite and fail in production.
 *
 * THREAT-MODEL T8 (callback forgery / replay) is closed by three things together:
 * the HMAC over timestamp *and* body, the {@link SIGNATURE_SKEW_MS} window, and
 * `(jobId, attemptId)` idempotency in the handler. This file owns the first two.
 *
 * **Two-key rotation.** `INTERNAL_CALLBACK_SECRET_NEXT` is the incoming secret
 * during a roll. A signature is checked against the primary first and, only if
 * that fails, against the next one — so an operator can set the new secret,
 * restart every worker onto it one at a time, then promote it and clear the old
 * one, without a single completion callback being rejected in between. Workers
 * only ever sign with the one secret they were given; the API is the side that
 * accepts both.
 *
 * `X-Montaj-*` uses the engineering codename, which is correct for a wire header
 * (CONTRACTS §0 covers user-visible strings).
 */

export const ATTEMPT_HEADER = "x-montaj-attempt";
export const TIMESTAMP_HEADER = "x-montaj-timestamp";
export const SIGNATURE_HEADER = "x-montaj-signature";

/** Replay window: five minutes either side, per CONTRACTS §3. */
export const SIGNATURE_SKEW_MS = 5 * 60_000;

/** Anything at or above this looks like milliseconds, and is a caller bug. */
const MILLISECOND_THRESHOLD = 1e11;

export interface SignInput {
  readonly secret: string;
  /** Unix **seconds**, as it will appear in the header. */
  readonly timestamp: number | string;
  /** Exact bytes of the request body. */
  readonly body: string | Buffer;
}

/** The hex signature for a request. Used by the guard, the tests and the workers. */
export function signInternalRequest(input: SignInput): string {
  const hmac = createHmac("sha256", input.secret);
  hmac.update(`${String(input.timestamp)}.`);
  hmac.update(input.body);
  return hmac.digest("hex");
}

/** Headers a signed request needs, ready to spread into a fetch. */
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

export type SignatureFailure =
  | "missing_attempt"
  | "missing_timestamp"
  | "missing_signature"
  | "missing_body"
  | "malformed_timestamp"
  | "timestamp_skew"
  | "signature_mismatch";

export type SignatureCheck =
  | {
      readonly ok: true;
      readonly attemptId: string;
      /** Which key verified it, so a roll can be watched in the logs. */
      readonly key: "primary" | "next";
    }
  | { readonly ok: false; readonly failure: SignatureFailure };

export interface VerifyInput {
  /** The primary `INTERNAL_CALLBACK_SECRET`. */
  readonly secret: string;
  /** `INTERNAL_CALLBACK_SECRET_NEXT`, when a rotation is in progress. */
  readonly secretNext?: string | undefined;
  readonly attempt: unknown;
  readonly timestamp: unknown;
  readonly signature: unknown;
  /** Raw body bytes as received. */
  readonly body: Buffer | undefined;
  readonly now?: number;
  readonly skewMs?: number;
}

/**
 * Verify a signed internal request.
 *
 * Order matters: presence, then the timestamp window, then the HMAC. Checking the
 * window first means a replayed-but-valid request costs one integer comparison
 * rather than an HMAC.
 */
export function verifyInternalSignature(input: VerifyInput): SignatureCheck {
  const attempt = asHeader(input.attempt);
  if (attempt === undefined) return { ok: false, failure: "missing_attempt" };

  const timestampHeader = asHeader(input.timestamp);
  if (timestampHeader === undefined) return { ok: false, failure: "missing_timestamp" };

  const signature = asHeader(input.signature);
  if (signature === undefined) return { ok: false, failure: "missing_signature" };

  if (input.body === undefined) return { ok: false, failure: "missing_body" };

  if (!/^\d{1,15}$/.test(timestampHeader)) return { ok: false, failure: "malformed_timestamp" };
  const seconds = Number(timestampHeader);
  if (seconds >= MILLISECOND_THRESHOLD) return { ok: false, failure: "malformed_timestamp" };

  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? SIGNATURE_SKEW_MS;
  if (Math.abs(now - seconds * 1000) > skew) return { ok: false, failure: "timestamp_skew" };

  const candidates: { key: "primary" | "next"; secret: string }[] = [
    { key: "primary", secret: input.secret },
  ];
  if (input.secretNext !== undefined && input.secretNext !== "") {
    candidates.push({ key: "next", secret: input.secretNext });
  }

  for (const candidate of candidates) {
    const expected = signInternalRequest({
      secret: candidate.secret,
      timestamp: timestampHeader,
      body: input.body,
    });
    // Every candidate is compared in constant time, and the loop always runs to
    // the first match rather than short-circuiting on length, so the number of
    // configured keys is the only thing timing can reveal.
    if (constantTimeEquals(expected, signature)) {
      return { ok: true, attemptId: attempt, key: candidate.key };
    }
  }

  return { ok: false, failure: "signature_mismatch" };
}

function asHeader(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  // Express hands back an array when a header is repeated; a repeated signature
  // header is not something a legitimate client sends.
  return undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
