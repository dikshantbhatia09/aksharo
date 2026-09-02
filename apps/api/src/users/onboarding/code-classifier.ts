/**
 * Classifies a code typed into onboarding's "How did you find us?" step (B17
 * brief §1: "code field accepting affiliate or referral codes (classified by
 * prefix; validation messages)").
 *
 * Referral codes are `AK-XXXXXX` (`referrals/referral-code.ts`'s
 * `isReferralCode`); affiliate codes are 8-character Crockford base32
 * (`affiliates/code.service.ts`'s alphabet, minus `I`/`L`/`O`/`U`). This
 * module only classifies the *shape* of a code — whether it exists is a
 * server round-trip (`POST /referrals/claim` or
 * `POST /affiliate/attribution/attach`), never guessed client-side.
 */
export type OnboardingCodeType = "affiliate" | "referral" | "invalid";

const REFERRAL_PATTERN = /^AK-[A-Z0-9]{4,10}$/;
const AFFILIATE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6,10}$/;

export function classifyOnboardingCode(rawCode: string): OnboardingCodeType {
  const code = rawCode.trim().toUpperCase();
  if (code === "") return "invalid";
  if (REFERRAL_PATTERN.test(code)) return "referral";
  if (AFFILIATE_PATTERN.test(code)) return "affiliate";
  return "invalid";
}
