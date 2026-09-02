import { INDIA_COUNTRY } from "./tax.constants.js";
import { validateGstin } from "../workspaces/gstin.js";

import type { $Enums } from "@prisma/client";

/**
 * Place of supply (B05 brief §1; D41; RR-05 D2/D3): **GSTIN → recorded State →
 * billing address**.
 *
 * `workspaces/tax-profile.ts` already collapses "recorded State" and "billing
 * address" into one validated `billingStateCode` at checkout time (Circular
 * 242/36/2024-GST makes the recorded State *the* address on record), so this
 * function's ladder is really two rungs: the GSTIN's own State code when a
 * GSTIN is present (it is definitionally correct and cannot disagree with the
 * recorded State — `tax-profile.ts` rejects a GSTIN whose State does not match
 * at signup), then the recorded State.
 *
 * Pure, like `tax-profile.ts`, so the place-of-supply/supply-type table is
 * assertable without a database.
 */

export type SupplyType = $Enums.SupplyType;

export interface PlaceOfSupplyInput {
  /** ISO-3166-1 alpha-2. */
  readonly recipientCountry: string;
  /** GSTIN present ⇒ B2B (brief §2). */
  readonly recipientGstin?: string | null | undefined;
  /** D41: mandatory, validated, for every India B2C invoice. */
  readonly recipientStateCode?: string | null | undefined;
  /** Our own GST State — from `tax_registrations`/`BRAND` config. */
  readonly supplierStateCode: string;
  /**
   * `true` for a self-invoice raised on an imported service under RCM (s.5(3)
   * IGST) — brief §1: "data model only, generation optional". The "recipient"
   * of the place-of-supply computation is then Aksharo itself.
   */
  readonly isImportOfService?: boolean;
  /**
   * Explicit SEZ override. Nothing in the source material describes how SEZ
   * status is *detected* (no SEZ flag exists anywhere in the data model), so
   * `supplyType: "sez"` is never inferred — only ever produced when a caller
   * asserts it directly. Flagged in the work package report as an open
   * question for the CA.
   */
  readonly isSez?: boolean;
}

export type PlaceOfSupplyProblem = "gstin_malformed" | "state_required";

export interface PlaceOfSupplyResult {
  readonly stateCode: string | null;
  readonly country: string;
  readonly supplyType: SupplyType;
  readonly reverseCharge: boolean;
}

export type PlaceOfSupplyOutcome =
  | { readonly ok: true; readonly result: PlaceOfSupplyResult }
  | { readonly ok: false; readonly problem: PlaceOfSupplyProblem; readonly message: string };

export function determinePlaceOfSupply(input: PlaceOfSupplyInput): PlaceOfSupplyOutcome {
  if (input.isImportOfService === true) {
    // RCM: we are the recipient; place of supply is our own registered State.
    return {
      ok: true,
      result: {
        stateCode: input.supplierStateCode,
        country: INDIA_COUNTRY,
        supplyType: "import_rcm",
        reverseCharge: true,
      },
    };
  }

  const country = input.recipientCountry.trim().toUpperCase();

  if (country !== INDIA_COUNTRY) {
    // Export of services, zero-rated under LUT (RR-05 E1/E2) — or, when the
    // caller has asserted it, a SEZ supply (also zero-rated, brief §2).
    return {
      ok: true,
      result: {
        stateCode: null,
        country,
        supplyType: input.isSez === true ? "sez" : "export",
        reverseCharge: false,
      },
    };
  }

  // Domestic: GSTIN's own State code first (B2B), else the recorded State (B2C).
  let stateCode: string | null = null;
  if (input.recipientGstin !== null && input.recipientGstin !== undefined) {
    const verdict = validateGstin(input.recipientGstin, input.recipientStateCode ?? undefined);
    if (!verdict.ok) {
      return {
        ok: false,
        problem: "gstin_malformed",
        message: "The recipient GSTIN failed validation; place of supply cannot be derived.",
      };
    }
    stateCode = verdict.stateCode;
  } else if (input.recipientStateCode !== null && input.recipientStateCode !== undefined) {
    stateCode = input.recipientStateCode;
  }

  if (stateCode === null) {
    return {
      ok: false,
      problem: "state_required",
      message:
        "An Indian recipient needs a State (from the GSTIN or the recorded billing State) " +
        "before place of supply can be determined (Circular 242/36/2024-GST).",
    };
  }

  return {
    ok: true,
    result: {
      stateCode,
      country,
      supplyType: stateCode === input.supplierStateCode ? "intra_state" : "inter_state",
      reverseCharge: false,
    },
  };
}
