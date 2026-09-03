/**
 * Signing and verifying a {@link RenderManifest}.
 *
 * ```
 * signature = hex(hmac_sha256(secret, "montaj.render-manifest.v1." + canonicalJson(manifest_without_signature)))
 * ```
 *
 * Three decisions, each closing a specific hole:
 *
 * 1. **Canonical JSON, not the wire bytes.** The completion callback of
 *    CONTRACTS §3 signs the exact bytes because both ends hold them; a manifest
 *    does not survive that way — it goes through a database column, a job
 *    payload and `JSON.parse`/`JSON.stringify` on the way here, and any of those
 *    may reorder keys. So the signature is over a canonical form: keys sorted,
 *    `undefined` dropped, no whitespace. Zod has already coerced defaults by the
 *    time this runs, so the issuer and the verifier canonicalise the same object.
 * 2. **A domain-separation prefix.** The signing key is
 *    `INTERNAL_CALLBACK_SECRET`, which also signs worker → API callbacks. The
 *    prefix means a manifest signature can never be replayed as a callback
 *    signature, or the other way round.
 * 3. **Two-key verification.** `INTERNAL_CALLBACK_SECRET_NEXT` is accepted as a
 *    second verification key exactly as the API accepts it for callbacks, so one
 *    rotation procedure covers both directions. The issuer always signs with the
 *    primary.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { RenderManifestError } from "./errors.js";
import { type RenderManifest, type UnsignedRenderManifest } from "./schema.js";

/**
 * Domain separator. Bump it with `v` in the schema: a v2 manifest must not
 * verify under a v1 signature even if every field happens to match.
 */
export const MANIFEST_SIGNATURE_DOMAIN = "montaj.render-manifest.v1.";

/** Canonical JSON: keys sorted, `undefined` dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return "null";
}

/** The exact string the HMAC is taken over. Exported so a test can show it. */
export function signingPayload(manifest: UnsignedRenderManifest): string {
  const { signature: _ignored, ...rest } = manifest as UnsignedRenderManifest & {
    signature?: unknown;
  };
  return `${MANIFEST_SIGNATURE_DOMAIN}${canonicalJson(rest)}`;
}

/** The hex signature for a manifest. A21 calls this; the renderer never does. */
export function signRenderManifest(manifest: UnsignedRenderManifest, secret: string): string {
  // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
  if (secret === "") {
    throw new RenderManifestError(
      "manifest/no-secret",
      "a render manifest cannot be signed without INTERNAL_CALLBACK_SECRET",
    );
  }
  return createHmac("sha256", secret).update(signingPayload(manifest), "utf8").digest("hex");
}

/** Signs `manifest` and returns it with the `signature` field filled in. */
export function withSignature(manifest: UnsignedRenderManifest, secret: string): RenderManifest {
  return { ...manifest, signature: signRenderManifest(manifest, secret) };
}

/** Which configured key verified a manifest, so a rotation can be watched. */
export type SignatureKey = "primary" | "next";

export interface VerifySignatureInput {
  readonly manifest: RenderManifest;
  /** The primary `INTERNAL_CALLBACK_SECRET`. */
  readonly secret: string;
  /** `INTERNAL_CALLBACK_SECRET_NEXT`, when a rotation is in progress. */
  readonly secretNext?: string | undefined;
}

/**
 * Constant-time signature check against the primary key and, when configured,
 * the rotation key. Returns which key matched, or `null` for no match.
 */
export function verifyManifestSignature(input: VerifySignatureInput): SignatureKey | null {
  const candidates: { key: SignatureKey; secret: string }[] = [];
  if (input.secret !== "") candidates.push({ key: "primary", secret: input.secret });
  if (input.secretNext !== undefined && input.secretNext !== "") {
    candidates.push({ key: "next", secret: input.secretNext });
  }
  if (candidates.length === 0) {
    throw new RenderManifestError(
      "manifest/no-secret",
      "no INTERNAL_CALLBACK_SECRET is configured, so no manifest can be verified",
    );
  }

  let matched: SignatureKey | null = null;
  for (const candidate of candidates) {
    // Every candidate is compared, and in constant time, so the number of
    // configured keys is the only thing timing can reveal.
    const expected = signRenderManifest(input.manifest, candidate.secret);
    if (constantTimeEquals(expected, input.manifest.signature) && matched === null) {
      matched = candidate.key;
    }
  }
  return matched;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
