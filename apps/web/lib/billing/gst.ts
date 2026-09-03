/**
 * The 36 live GST State codes and the GSTIN check digit, mirrored client-side
 * for instant tax-profile-step feedback.
 *
 * `apps/api/src/workspaces/gst-state-codes.ts` and `gstin.ts` are the
 * authoritative implementations — `PUT /workspaces/{id}/tax-profile` is the
 * source of truth and this app has no dependency on `apps/api` to import them
 * from. Duplicated here rather than imported (same reasoning as
 * `endpoints.ts`'s header comment): the list is small, static and dated
 * 2020 (the last GST State-code change), so the duplication risk is low
 * against the value of not round-tripping to the server for every keystroke
 * of a 15-character field. The server re-validates everything on submit and
 * is what actually decides.
 */

export interface GstState {
  readonly code: string;
  readonly name: string;
  readonly type: "state" | "union_territory";
}

/** 28 States and 8 Union Territories — see `apps/api/.../gst-state-codes.ts` for
 * why `25`, `28`, `97` and `99` are deliberately absent. */
export const GST_STATES: readonly GstState[] = [
  { code: "01", name: "Jammu and Kashmir", type: "union_territory" },
  { code: "02", name: "Himachal Pradesh", type: "state" },
  { code: "03", name: "Punjab", type: "state" },
  { code: "04", name: "Chandigarh", type: "union_territory" },
  { code: "05", name: "Uttarakhand", type: "state" },
  { code: "06", name: "Haryana", type: "state" },
  { code: "07", name: "Delhi", type: "union_territory" },
  { code: "08", name: "Rajasthan", type: "state" },
  { code: "09", name: "Uttar Pradesh", type: "state" },
  { code: "10", name: "Bihar", type: "state" },
  { code: "11", name: "Sikkim", type: "state" },
  { code: "12", name: "Arunachal Pradesh", type: "state" },
  { code: "13", name: "Nagaland", type: "state" },
  { code: "14", name: "Manipur", type: "state" },
  { code: "15", name: "Mizoram", type: "state" },
  { code: "16", name: "Tripura", type: "state" },
  { code: "17", name: "Meghalaya", type: "state" },
  { code: "18", name: "Assam", type: "state" },
  { code: "19", name: "West Bengal", type: "state" },
  { code: "20", name: "Jharkhand", type: "state" },
  { code: "21", name: "Odisha", type: "state" },
  { code: "22", name: "Chhattisgarh", type: "state" },
  { code: "23", name: "Madhya Pradesh", type: "state" },
  { code: "24", name: "Gujarat", type: "state" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu", type: "union_territory" },
  { code: "27", name: "Maharashtra", type: "state" },
  { code: "29", name: "Karnataka", type: "state" },
  { code: "30", name: "Goa", type: "state" },
  { code: "31", name: "Lakshadweep", type: "union_territory" },
  { code: "32", name: "Kerala", type: "state" },
  { code: "33", name: "Tamil Nadu", type: "state" },
  { code: "34", name: "Puducherry", type: "union_territory" },
  { code: "35", name: "Andaman and Nicobar Islands", type: "union_territory" },
  { code: "36", name: "Telangana", type: "state" },
  { code: "37", name: "Andhra Pradesh", type: "state" },
  { code: "38", name: "Ladakh", type: "union_territory" },
];

const BY_CODE: ReadonlyMap<string, GstState> = new Map(
  GST_STATES.map((state) => [state.code, state]),
);

export function isGstStateCode(code: string): boolean {
  return BY_CODE.has(code);
}

export function gstState(code: string): GstState | undefined {
  return BY_CODE.get(code);
}

// --- GSTIN checksum (mirrors apps/api/src/workspaces/gstin.ts) --------------

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GSTIN_LENGTH = 15;

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = ALPHABET.length;

export type GstinProblem =
  "malformed" | "checksum_mismatch" | "unknown_state_code" | "state_mismatch";

export interface GstinValid {
  readonly ok: true;
  readonly gstin: string;
  readonly stateCode: string;
}

export interface GstinInvalid {
  readonly ok: false;
  readonly problem: GstinProblem;
}

export type GstinResult = GstinValid | GstinInvalid;

/** The GSTN check digit for the first 14 characters: base-36 Luhn. */
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

/** Validate a GSTIN's shape, checksum and (optionally) its State against `expectedStateCode`. */
export function validateGstin(input: string, expectedStateCode?: string): GstinResult {
  const gstin = input.replace(/\s+/g, "").toUpperCase();
  if (!GSTIN_PATTERN.test(gstin)) return { ok: false, problem: "malformed" };

  const stateCode = gstin.slice(0, 2);
  if (gstinCheckDigit(gstin.slice(0, 14)) !== gstin[14]) {
    return { ok: false, problem: "checksum_mismatch" };
  }
  if (!isGstStateCode(stateCode)) return { ok: false, problem: "unknown_state_code" };
  if (expectedStateCode !== undefined && expectedStateCode !== stateCode) {
    return { ok: false, problem: "state_mismatch" };
  }
  return { ok: true, gstin, stateCode };
}

export const GSTIN_PROBLEM_MESSAGE: Record<GstinProblem, string> = {
  malformed:
    "A GSTIN is 15 characters: two digits, a PAN, an entity character, 'Z' and a check digit.",
  checksum_mismatch: "That GSTIN's check digit does not match — one character is wrong.",
  unknown_state_code: "That GSTIN begins with a State code that is not in use.",
  state_mismatch: "The GSTIN's State code and the billing State disagree.",
};

/** Server error `details.problem` from `workspace/tax_profile_invalid` → a sentence. */
export const TAX_PROFILE_PROBLEM_MESSAGE: Record<string, string> = {
  country_invalid: "Choose a country.",
  state_required: "State is required for an Indian billing address.",
  state_invalid: "That is not a GST State.",
  state_not_applicable: "State only applies to an Indian billing address.",
  gstin_not_applicable: "A GSTIN only applies to an Indian billing address.",
  ...GSTIN_PROBLEM_MESSAGE,
};
