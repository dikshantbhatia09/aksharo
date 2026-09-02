import { isGstStateCode } from "./gst-state-codes.js";
import { validateGstin } from "./gstin.js";

import type { GstinProblem } from "./gstin.js";
import type { $Enums } from "@prisma/client";

/**
 * The tax profile rules of `04 §Tax` and D41, as one pure function.
 *
 * Pure because these are the rules every later invoice is built on: they have to
 * be assertable without a database, a workspace or a booted Nest application.
 */

export const INDIA = "IN";

/** Currency follows the billing country, and nothing else (04 §Tax). */
export function currencyForCountry(billingCountry: string): $Enums.Currency {
  return billingCountry === INDIA ? "INR" : "USD";
}

/** EU/EEA ISO-3166-1 alpha-2 codes, for the region pin only — not for VAT. */
const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

/**
 * Data residency (THREAT-MODEL T24). `in` is the default: raw media and the
 * database live in ap-south-1 unless a workspace says otherwise, and only the EU
 * and the rest of the world have a reason to say otherwise.
 */
export function regionForCountry(billingCountry: string): $Enums.Region {
  if (billingCountry === INDIA) return "in";
  return EU_COUNTRIES.has(billingCountry) ? "eu" : "us";
}

export interface TaxProfileInput {
  /** ISO-3166-1 alpha-2. Case and surrounding space are normalised. */
  readonly billingCountry: string;
  readonly billingStateCode?: string | undefined;
  readonly gstin?: string | undefined;
  readonly legalName?: string | undefined;
}

export interface TaxProfile {
  readonly billingCountry: string;
  readonly billingStateCode: string | null;
  readonly gstin: string | null;
  readonly legalName: string | null;
  readonly currency: $Enums.Currency;
  readonly region: $Enums.Region;
}

export type TaxProfileProblem =
  | "country_invalid"
  | "state_required"
  | "state_invalid"
  | "state_not_applicable"
  | "gstin_malformed"
  | "gstin_checksum_mismatch"
  | "gstin_unknown_state"
  | "gstin_state_mismatch"
  | "gstin_not_applicable";

export interface TaxProfileRejected {
  readonly ok: false;
  readonly problem: TaxProfileProblem;
  readonly message: string;
  /** Machine-readable context; reaches the client as the error envelope's `details`. */
  readonly details?: Record<string, unknown>;
}

export type TaxProfileResult =
  { readonly ok: true; readonly profile: TaxProfile } | TaxProfileRejected;

const COUNTRY_PATTERN = /^[A-Z]{2}$/;

/** How a GSTIN problem is reported at the tax-profile level. */
const GSTIN_PROBLEMS: Record<GstinProblem, { problem: TaxProfileProblem; message: string }> = {
  malformed: {
    problem: "gstin_malformed",
    message:
      "A GSTIN is 15 characters: two digits, a PAN, an entity character, 'Z' and a check digit.",
  },
  checksum_mismatch: {
    problem: "gstin_checksum_mismatch",
    message: "That GSTIN's check digit does not match — one character is wrong.",
  },
  unknown_state_code: {
    problem: "gstin_unknown_state",
    message: "That GSTIN begins with a State code that is not in use.",
  },
  state_mismatch: {
    problem: "gstin_state_mismatch",
    message: "The GSTIN's State code and the billing State disagree.",
  },
};

function reject(
  problem: TaxProfileProblem,
  message: string,
  details?: Record<string, unknown>,
): TaxProfileRejected {
  return details === undefined
    ? { ok: false, problem, message }
    : { ok: false, problem, message, details };
}

/** Trim, and treat an empty string as "not supplied". */
function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Normalise and validate a tax profile.
 *
 * India (D41):
 *   * `billingStateCode` is **mandatory** and must be one of the 36 live GST
 *     State codes — it becomes the place of supply on every invoice;
 *   * `gstin` is optional, but when present it must pass the shape check **and**
 *     the base-36 check digit, and its first two digits must name the same State.
 *
 * Everywhere else there is no GST, so a State code or a GSTIN is **refused**
 * rather than quietly dropped: silently discarding a field the customer filled in
 * is how a wrong invoice gets issued with nobody noticing.
 */
export function validateTaxProfile(input: TaxProfileInput): TaxProfileResult {
  const billingCountry = trimmedOrNull(input.billingCountry)?.toUpperCase() ?? "";
  if (!COUNTRY_PATTERN.test(billingCountry)) {
    return reject("country_invalid", "billingCountry must be an ISO-3166-1 alpha-2 code.");
  }

  const legalName = trimmedOrNull(input.legalName);
  const stateCode = trimmedOrNull(input.billingStateCode);
  const rawGstin = trimmedOrNull(input.gstin);

  if (billingCountry !== INDIA) {
    if (stateCode !== null) {
      return reject(
        "state_not_applicable",
        "billingStateCode is a GST State code and applies only to India.",
      );
    }
    if (rawGstin !== null) {
      return reject("gstin_not_applicable", "A GSTIN applies only to India.");
    }
    return {
      ok: true,
      profile: {
        billingCountry,
        billingStateCode: null,
        gstin: null,
        legalName,
        currency: currencyForCountry(billingCountry),
        region: regionForCountry(billingCountry),
      },
    };
  }

  if (stateCode === null) {
    return reject(
      "state_required",
      "An Indian billing address needs a GST State code (Circular 242/36/2024-GST).",
    );
  }
  if (!isGstStateCode(stateCode)) {
    return reject("state_invalid", "That is not a GST State code.", {
      billingStateCode: stateCode,
    });
  }

  let gstin: string | null = null;
  if (rawGstin !== null) {
    const verdict = validateGstin(rawGstin, stateCode);
    if (!verdict.ok) {
      const mapped = GSTIN_PROBLEMS[verdict.problem];
      return reject(mapped.problem, mapped.message, {
        billingStateCode: stateCode,
        ...(verdict.stateCode === undefined ? {} : { gstinStateCode: verdict.stateCode }),
      });
    }
    gstin = verdict.gstin;
  }

  return {
    ok: true,
    profile: {
      billingCountry,
      billingStateCode: stateCode,
      gstin,
      legalName,
      currency: "INR",
      region: "in",
    },
  };
}
