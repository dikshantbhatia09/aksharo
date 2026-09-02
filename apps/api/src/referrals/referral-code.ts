import { randomInt } from "node:crypto";

import { REFERRAL_CODE_PREFIX } from "./referrals.constants.js";

/**
 * Personal referral codes: `AK-XXXXXX`, 6 characters from an unambiguous
 * alphabet (no `0/O`, `1/I/L`), same reasoning as `auth/tokens.ts`'s device
 * user codes — a code gets read aloud and typed by hand.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateReferralCode(): string {
  let body = "";
  for (let i = 0; i < 6; i += 1) {
    body += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${REFERRAL_CODE_PREFIX}${body}`;
}

/**
 * Classifies a code posted at onboarding (brief §2: "accept both affiliate
 * and referral codes; classify by prefix"). Referral codes are `AK-XXXXXX`;
 * anything else is left for B07's affiliate attribution to handle — this
 * module never touches `affiliates`/`coupons`.
 */
export function isReferralCode(code: string): boolean {
  return /^AK-[A-Z0-9]{4,10}$/.test(code.trim().toUpperCase());
}

export function normalizeReferralCode(code: string): string {
  return code.trim().toUpperCase();
}
