import type { $Enums } from "@prisma/client";

/**
 * The jurisdictional age gate (D60, 05 §8, brief §7).
 *
 * India blocks under-18s and the EU blocks under-16s at sign-up until a verifiable
 * parental-consent flow ships (DigiLocker-class token, before May 2027); a blocked
 * sign-up is offered the parental waitlist instead. Anyone under 18 anywhere is
 * recorded as `minor`, because D60 also switches product analytics, streaks,
 * referral and affiliate targeting off for declared minors.
 *
 * Pure and dependency-free so the boundary cases are cheap to test.
 */

/** Minimum age to sign up unaided, by declared jurisdiction. */
export const MINIMUM_AGE: Readonly<Record<$Enums.Jurisdiction, number>> = {
  IN: 18,
  EU: 16,
  OTHER: 0,
};

/** Below this, a user is a `minor` for consent and targeting purposes. */
export const MINOR_AGE = 18;

export interface AgeGateInput {
  /** Date of birth. Date-only: no time component is ever collected (06 `users`). */
  readonly dateOfBirth: Date;
  readonly jurisdiction: $Enums.Jurisdiction;
  /** Defaults to now; injected by tests. */
  readonly now?: Date;
}

export interface AgeGateVerdict {
  readonly ageYears: number;
  readonly ageBracket: $Enums.AgeBracket;
  readonly allowed: boolean;
  /** The threshold that rejected the sign-up, for the error `details`. */
  readonly minimumAge: number;
}

/** Whole years between `dateOfBirth` and `now`, in UTC. */
export function ageInYears(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1;
  }
  return age;
}

export function evaluateAgeGate(input: AgeGateInput): AgeGateVerdict {
  const now = input.now ?? new Date();
  const ageYears = ageInYears(input.dateOfBirth, now);
  const minimumAge = MINIMUM_AGE[input.jurisdiction];
  return {
    ageYears,
    ageBracket: ageYears < MINOR_AGE ? "minor" : "adult",
    allowed: ageYears >= minimumAge,
    minimumAge,
  };
}

/** `true` when a date of birth is a real, past, plausible date. */
export function isPlausibleDateOfBirth(value: Date, now: Date = new Date()): boolean {
  if (Number.isNaN(value.getTime())) return false;
  if (value.getTime() > now.getTime()) return false;
  return ageInYears(value, now) <= 120;
}
