import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { USER_CODE_ALPHABET, USER_CODE_LENGTH } from "./auth.constants.js";

/**
 * Opaque-token primitives shared by refresh tokens, device codes, magic links,
 * e-mail verification and the OAuth handoff.
 *
 * The rule they all follow: the API hands out a high-entropy value once and keeps
 * only `sha256` of it. A database or Redis dump therefore contains nothing that
 * can be replayed. SHA-256 (not argon2) is right here because the input already
 * has 256 bits of entropy — there is nothing to brute-force.
 */

/** `bytes` of CSPRNG output, base64url, no padding. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * A device user code: 8 characters from an alphabet with no `0/O`, `1/I/L`,
 * `5/S`, `8/B`... (CONTRACTS §5). `randomInt` is rejection-sampled by Node, so the
 * distribution is uniform — `randomBytes(n) % 28` would not be.
 */
export function generateUserCode(): string {
  let code = "";
  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** `BCDF-GHJK`, the form shown on the device and typed into the web page. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Accept what a human actually types: lower case, spaces, the grouping dash.
 * Returns `undefined` when the result is not a well-formed code, so an unknown
 * code and a malformed one take the same path.
 */
export function normaliseUserCode(input: string): string | undefined {
  const cleaned = input.replace(/[\s-]/g, "").toUpperCase();
  if (cleaned.length !== USER_CODE_LENGTH) return undefined;
  for (const character of cleaned) {
    if (!USER_CODE_ALPHABET.includes(character)) return undefined;
  }
  return cleaned;
}

/** PKCE (RFC 7636 §4.1): 43–128 characters of unreserved ASCII. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256 challenge: `base64url(sha256(verifier))`. */
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
