import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP, hand-rolled with `node:crypto` alone — same call as
 * `TokenService`'s RS256 JWT ("no JWT library... easier to audit than a
 * general-purpose [dependency]"). This is the only TOTP consumer in the
 * platform (admin step-up, `POST /admin/auth/step-up`); nothing else needs it.
 *
 * Parameters match every authenticator app's defaults: SHA-1, 6 digits, a
 * 30-second step. Verification checks one step before and after the current
 * one (±30s window) to tolerate clock drift, per RFC 6238 §6.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW_STEPS = 1;

/** A fresh random 20-byte (160-bit) secret, base32-encoded (RFC 4648 §6, no padding). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** `otpauth://` URI for QR-code enrolment in an authenticator app. */
export function totpProvisioningUri(params: {
  readonly secret: string;
  readonly accountName: string;
  readonly issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** True if `code` (6 ASCII digits) is valid for `secret` within the drift window. */
export function verifyTotpCode(secret: string, code: string, now: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -WINDOW_STEPS; drift <= WINDOW_STEPS; drift += 1) {
    const expected = hotp(secret, counter + drift);
    if (safeEqualDigits(expected, code)) return true;
  }
  return false;
}

/** The code valid right now — used by enrolment tests and seed scripts, never by verification. */
export function currentTotpCode(secret: string, now: number = Date.now()): string {
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  return hotp(secret, counter);
}

function hotp(base32Secret: string, counter: number): string {
  const key = base32Decode(base32Secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  const otp = binary % 10 ** DIGITS;
  return otp.toString().padStart(DIGITS, "0");
}

function safeEqualDigits(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/u, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
