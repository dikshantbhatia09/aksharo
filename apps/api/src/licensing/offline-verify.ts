import { createPublicKey, createVerify } from "node:crypto";

import { LICENSE_CLOCK_SKEW_MS } from "./licensing.constants.js";

import type { LicenseSnapshotPayload } from "./plugins.service.js";

/**
 * The offline half of licence verification (05 section 8, THREAT-MODEL T15):
 * what a plugin or the desktop app runs entirely locally, with a public key
 * it ships baked in (`JWT_PUBLIC_KEY`'s public half -- `kid` in the payload
 * says which one), never phoning home. This is a reference implementation of
 * the exact algorithm this API's `signing.service.ts` expects a client to
 * run; it is not called from any server route (the server only signs).
 *
 * Verifies, in order: shape, algorithm (rejects anything but `RS256` before
 * ever touching the signature -- `alg: none` and HMAC confusion have no
 * path through this), signature, and finally the 7-day offline window with
 * `LICENSE_CLOCK_SKEW_MS` (5 minutes) of tolerance either side for a client
 * clock that is not perfectly synchronised -- generous enough to absorb an
 * unsynced clock, narrow enough that it cannot meaningfully extend the
 * 7-day window itself.
 */
export type OfflineVerifyResult =
  | { readonly ok: true; readonly payload: LicenseSnapshotPayload }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "bad_algorithm" | "bad_signature" | "expired";
    };

export function verifyOfflineSnapshot(
  token: string,
  publicKeyPem: string,
  now: Date = new Date(),
): OfflineVerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "RS256"
  ) {
    return { ok: false, reason: "bad_algorithm" };
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let signatureOk: boolean;
  try {
    signatureOk = createVerify("RSA-SHA256")
      .update(signingInput, "utf8")
      .verify(createPublicKey(publicKeyPem), Buffer.from(encodedSignature, "base64url"));
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  const claims = payload as Partial<LicenseSnapshotPayload>;
  if (typeof claims.exp !== "string") return { ok: false, reason: "malformed" };
  const expiresAt = new Date(claims.exp).getTime();
  if (Number.isNaN(expiresAt) || now.getTime() > expiresAt + LICENSE_CLOCK_SKEW_MS) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload: claims as LicenseSnapshotPayload };
}
