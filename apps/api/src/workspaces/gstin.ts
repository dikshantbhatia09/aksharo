import { isGstStateCode } from "./gst-state-codes.js";

/**
 * GSTIN validation: shape, check digit, and the State the number itself declares.
 *
 * A GSTIN is 15 characters:
 *
 * ```
 *   27  AAPFU0939F  1  Z  V
 *   ^^  ^^^^^^^^^^  ^  ^  ^
 *   |   |           |  |  check digit (base-36, computed below)
 *   |   |           |  literal 'Z', reserved by the GSTN
 *   |   |           entity number for this PAN in this State, 1-9 then A-Z
 *   |   the holder's 10-character PAN
 *   State code (the first two digits — D41 derives the place of supply from it)
 * ```
 *
 * Validating the check digit matters because the field is typed by hand at
 * checkout and a transposed character produces a *plausible* GSTIN that fails
 * months later, on a return, when the invoice can no longer be reissued.
 */

/** Shape only. The check digit and the State are separate assertions. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GSTIN_LENGTH = 15;

/** The GSTN check-digit alphabet: base 36, digits before letters. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = ALPHABET.length;

export type GstinProblem =
  "malformed" | "checksum_mismatch" | "unknown_state_code" | "state_mismatch";

export interface GstinValid {
  readonly ok: true;
  /** Uppercased, whitespace stripped. */
  readonly gstin: string;
  /** The first two characters: the State that fixes the place of supply. */
  readonly stateCode: string;
  /** Characters 3-12: the holder's PAN. */
  readonly pan: string;
}

export interface GstinInvalid {
  readonly ok: false;
  readonly problem: GstinProblem;
  /** For `state_mismatch`: what the number says the State is. */
  readonly stateCode?: string;
}

export type GstinResult = GstinValid | GstinInvalid;

/**
 * The GSTN check digit for the first 14 characters of a GSTIN.
 *
 * Weights alternate 1, 2, 1, 2 … from the left. Each product is folded back into
 * base 36 (`quotient + remainder`) rather than truncated, and the check digit is
 * whatever brings the total to a multiple of 36 — the same construction as the
 * Luhn algorithm, in base 36 instead of base 10.
 *
 * Returns `undefined` when any of the 14 characters is outside the alphabet, so
 * a malformed input can never produce a confident answer.
 */
export function gstinCheckDigit(first14: string): string | undefined {
  if (first14.length !== GSTIN_LENGTH - 1) return undefined;

  let sum = 0;
  for (let index = 0; index < first14.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const value = ALPHABET.indexOf(first14[index] ?? "");
    if (value < 0) return undefined;
    const factor = index % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / BASE) + (product % BASE);
  }

  return ALPHABET[(BASE - (sum % BASE)) % BASE];
}

/**
 * Validate a GSTIN, optionally against the State the workspace claims.
 *
 * `expectedStateCode` is the workspace's `billingStateCode`. D41 makes the two
 * agree by construction: the place of supply is "GSTIN → recorded State → billing
 * address", so a GSTIN whose first two digits name a different State would make
 * the invoice self-contradictory.
 */
export function validateGstin(input: string, expectedStateCode?: string): GstinResult {
  const gstin = input.replace(/\s+/g, "").toUpperCase();

  if (!GSTIN_PATTERN.test(gstin)) return { ok: false, problem: "malformed" };

  const stateCode = gstin.slice(0, 2);
  const pan = gstin.slice(2, 12);

  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return { ok: false, problem: "checksum_mismatch" };
  }
  if (!isGstStateCode(stateCode)) {
    return { ok: false, problem: "unknown_state_code", stateCode };
  }
  if (expectedStateCode !== undefined && expectedStateCode !== stateCode) {
    return { ok: false, problem: "state_mismatch", stateCode };
  }

  return { ok: true, gstin, stateCode, pan };
}
