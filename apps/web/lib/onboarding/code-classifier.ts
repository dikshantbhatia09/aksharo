/**
 * Client-side mirror of `apps/api/src/users/onboarding/code-classifier.ts`.
 *
 * Kept in sync by hand rather than shared through a package: this is a
 * two-regex, no-dependency classification of a code's *shape* (B17 brief §1:
 * "accepting affiliate or referral codes (classified by prefix)"), used only
 * to decide inline whether to show an error before the round trip
 * (`POST /referrals/claim` / `POST /affiliate/attribution/attach`) that
 * actually resolves it. If the two ever drift, the server round trip is
 * still the source of truth — this only gates the immediate "that doesn't
 * look right" message.
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
