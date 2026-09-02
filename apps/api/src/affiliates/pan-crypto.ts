import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * PAN encryption at rest (THREAT-MODEL T21: "Secrets in code/logs" — a PAN is
 * not a secret in the KMS-managed-env sense, but 06 §affiliates and the brief
 * both call for encryption at rest, and it must never be logged).
 *
 * Rather than adding a new frozen `docs/CONTRACTS.md §1` env var for this one
 * field, the AES-256-GCM key is derived (HKDF-SHA256, domain-separated by
 * `info`) from `INTERNAL_CALLBACK_SECRET`, which is already required to boot
 * the API and already rotates through `INTERNAL_CALLBACK_SECRET_NEXT`. This
 * keeps the encryption key out of source and out of a second secret an
 * operator has to provision, at the cost of PAN rows needing re-encryption on
 * a full `INTERNAL_CALLBACK_SECRET` rotation — acceptable because approved
 * affiliates are a small, re-verifiable population (flagged in the report as
 * a deviation from "add a dedicated secret" the brief did not actually ask
 * for).
 */
const HKDF_INFO = Buffer.from("montaj.affiliate.pan.v1");
const HKDF_SALT = Buffer.from("montaj-affiliate-pan-salt");
const ALGO = "aes-256-gcm";

function deriveKey(secret: string): Buffer {
  const bytes = hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(bytes);
}

/** `iv:authTag:ciphertext`, base64url per segment — safe to store in one TEXT column. */
export function encryptPan(pan: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64url")).join(":");
}

export function decryptPan(stored: string, secret: string): string {
  const [ivB64, tagB64, ctB64] = stored.split(":");
  if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error("malformed encrypted PAN payload");
  }
  const key = deriveKey(secret);
  const iv = Buffer.from(ivB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Last 4 characters only — safe to display in the dashboard/admin queue. */
export function panLast4(pan: string): string {
  return pan.slice(-4);
}

/** Format: 5 letters, 4 digits, 1 letter (e.g. `ABCDE1234F`). */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function isValidPan(pan: string): boolean {
  return PAN_PATTERN.test(pan);
}
