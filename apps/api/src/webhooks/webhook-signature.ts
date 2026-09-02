import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `X-Aksharo-Signature` scheme (B14 §4).
 *
 * `t=<unix seconds>,v1=<hex hmac_sha256(secret, t + "." + body)>` — the same
 * shape Stripe popularised: the timestamp is folded into the signed material so
 * a captured request cannot be replayed indefinitely (a receiver checks `t` is
 * recent before trusting `v1` at all), and `v1` is versioned so a future scheme
 * can be added as `v2` alongside it without breaking an existing receiver.
 *
 * This file is also what `developers` §"Verify a webhook" documents — the
 * curl/Node/Python snippets on that page compute exactly what
 * {@link signWebhookPayload} does, and `webhook-signature.test.ts` executes the
 * Node snippet verbatim against {@link signWebhookPayload}'s own output, so the
 * two can never drift apart silently.
 */
export const WEBHOOK_SIGNATURE_HEADER = "X-Aksharo-Signature";

export interface WebhookSignature {
  readonly header: string;
  readonly timestamp: number;
  readonly signature: string;
}

function hmac(secret: string, signedPayload: string): string {
  return createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");
}

/** Sign a webhook body. `body` is the exact bytes sent on the wire, as a UTF-8 string. */
export function signWebhookPayload(
  secret: string,
  body: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): WebhookSignature {
  const signature = hmac(secret, `${String(timestamp)}.${body}`);
  return { header: `t=${String(timestamp)},v1=${signature}`, timestamp, signature };
}

/**
 * Verify a received `X-Aksharo-Signature` header.
 *
 * @param toleranceSec How far `t` may drift from now before the signature is
 *   refused regardless of whether it matches (replay protection). `Infinity`
 *   disables the check, which the delivery-log "resend" path and the tests use.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const parts = new Map<string, string>();
  for (const piece of header.split(",")) {
    const [key, value] = piece.split("=", 2);
    if (key === undefined || value === undefined) continue;
    parts.set(key, value);
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (t === undefined || v1 === undefined) return false;

  const timestamp = Number(t);
  if (!Number.isFinite(timestamp)) return false;
  if (Number.isFinite(toleranceSec) && Math.abs(now - timestamp) > toleranceSec) return false;

  const expected = hmac(secret, `${t}.${body}`);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(v1, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
