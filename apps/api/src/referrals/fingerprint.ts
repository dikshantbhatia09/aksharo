import { createHash } from "node:crypto";

/**
 * Abuse fingerprints (THREAT-MODEL T17: "device/IP fingerprints"). Only the
 * hash is ever stored — same reasoning as `auth/tokens.ts`'s `sha256Hex` for
 * refresh tokens: a database dump should not hand out raw IPs or user agents.
 * Not shared from `auth/` on purpose — a one-line `createHash` call is
 * cheaper than a cross-module dependency for something this small.
 */
export function hashFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
