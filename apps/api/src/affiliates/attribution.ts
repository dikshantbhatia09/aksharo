/**
 * Attribution precedence (brief §2, 04 §Affiliate): a code entered at
 * sign-up/checkout always wins; otherwise an unexpired 60-day last-click
 * cookie applies. Pure so "code beats cookie" / "expired cookie ignored" is a
 * table test with no HTTP or cookie jar involved.
 */

export const ATTRIBUTION_COOKIE_NAME = "aksh_aff";
export const ATTRIBUTION_COOKIE_DAYS = 60;

export interface AttributionCandidate {
  readonly source: "code" | "cookie";
  readonly code: string;
  /** Only present for a cookie candidate. */
  readonly attributionExpiresAt?: Date;
}

export interface ResolveAttributionInput {
  /** Code typed at sign-up/checkout, if any. */
  readonly enteredCode?: string | null;
  /** Cookie value set by a prior `/r/<code>` visit, if any. */
  readonly cookieCode?: string | null;
  readonly cookieExpiresAt?: Date | null;
  readonly now?: Date;
}

export function resolveAttribution(input: ResolveAttributionInput): AttributionCandidate | null {
  const enteredCode = input.enteredCode?.trim();
  if (enteredCode !== undefined && enteredCode !== "") {
    return { source: "code", code: enteredCode.toUpperCase() };
  }

  const now = input.now ?? new Date();
  const cookieCode = input.cookieCode?.trim();
  if (
    cookieCode !== undefined &&
    cookieCode !== "" &&
    input.cookieExpiresAt !== undefined &&
    input.cookieExpiresAt !== null &&
    input.cookieExpiresAt > now
  ) {
    return {
      source: "cookie",
      code: cookieCode.toUpperCase(),
      attributionExpiresAt: input.cookieExpiresAt,
    };
  }

  return null;
}

export function cookieExpiryFrom(clickedAt: Date): Date {
  return new Date(clickedAt.getTime() + ATTRIBUTION_COOKIE_DAYS * 24 * 60 * 60 * 1000);
}
