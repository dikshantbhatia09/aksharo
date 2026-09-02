import type { Jurisdiction } from "@montaj/api-client";

/**
 * D60, in the browser.
 *
 * The API is the authority — it answers `403 auth/age_restricted` and it is the
 * only thing an attacker cannot edit — but the form checks the same rule so a
 * 15-year-old sees a kind explanation instead of a red error after submitting a
 * password. Both sides use the same numbers, and `age-gate.test.ts` pins them.
 */

/**
 * India blocks under-18s and the EU under-16s (D60). Elsewhere there is no
 * declared floor, so the gate does not invent one: these are the same numbers
 * `apps/api/src/auth/age-gate.ts` enforces, and a client that guessed a stricter
 * rule would reject sign-ups the server would have accepted.
 */
export const MINIMUM_AGE: Record<Jurisdiction, number> = {
  IN: 18,
  EU: 16,
  OTHER: 0,
};

/** Anyone under this is a "minor" for D60's targeting rules, everywhere. */
export const MINOR_AGE = 18;

/** Whole years between `dateOfBirth` (`YYYY-MM-DD`) and `on`. */
export function ageInYears(dateOfBirth: string, on: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (match === null) return null;
  const [, year, month, day] = match;
  const born = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(born.getTime())) return null;
  if (born.getUTCMonth() !== Number(month) - 1 || born.getUTCDate() !== Number(day)) return null;
  if (born.getTime() > on.getTime()) return null;

  let age = on.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < born.getUTCMonth() ||
    (on.getUTCMonth() === born.getUTCMonth() && on.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export interface AgeDecision {
  /** `false` when the date does not parse or is in the future. */
  valid: boolean;
  age: number | null;
  /** The jurisdiction blocks this account until a parental-consent flow exists. */
  blocked: boolean;
  /** D60: analytics, streaks, referral and affiliate targeting stay off. */
  minor: boolean;
}

export function evaluateAge(
  dateOfBirth: string,
  jurisdiction: Jurisdiction,
  on: Date = new Date(),
): AgeDecision {
  const age = ageInYears(dateOfBirth, on);
  if (age === null || age > 120) {
    return { valid: false, age: null, blocked: false, minor: false };
  }
  return {
    valid: true,
    age,
    blocked: age < MINIMUM_AGE[jurisdiction],
    minor: age < MINOR_AGE,
  };
}

export const JURISDICTION_LABEL: Record<Jurisdiction, string> = {
  IN: "India",
  EU: "European Union / EEA",
  OTHER: "Somewhere else",
};

/** Ordered for the picker: India first, because that is most of the audience. */
export const JURISDICTIONS: Jurisdiction[] = ["IN", "EU", "OTHER"];
