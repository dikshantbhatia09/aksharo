/**
 * Fixed tax facts (B05 brief; `03-architecture/04-pricing-and-monetization.md`
 * v2 §Tax; D41; RR-05 §D).
 *
 * Everything here is a published rate or a fixed piece of statutory wording, not
 * a business decision this work package is free to make — where the source
 * material could not confirm an exact value (the SAC code, RR-05 open question
 * 2 — "[CA] Exact SAC for our supply") a clearly-flagged placeholder is used and
 * `tax_registrations`/env can override it later without a code change.
 */

/** Standard GST rate on the supply, in basis points. 18% (RR-05 D1: SaaS/IT services post GST 2.0). */
export const STANDARD_GST_RATE_BPS = 1800;

/** Intra-state split: CGST + SGST, each half the standard rate. */
export const CGST_RATE_BPS = STANDARD_GST_RATE_BPS / 2;
export const SGST_RATE_BPS = STANDARD_GST_RATE_BPS / 2;

/** Inter-state: the whole rate as IGST. */
export const IGST_RATE_BPS = STANDARD_GST_RATE_BPS;

/** Export under LUT and RCM self-invoices carry no output tax. */
export const ZERO_RATE_BPS = 0;

/**
 * Default SAC (Services Accounting Code) for the supply.
 *
 * **[CA]** RR-05 open question 2 flags that the exact SAC for an AI captioning
 * / video-editing SaaS was not confirmed. `998316` ("IT design and development
 * services") is the closest published category to what the product does today
 * and is used as the default so every invoice this work package produces has a
 * populated, syntactically valid SAC — but it MUST be confirmed by a CA before
 * the first real invoice ships, and `TaxRegistrationsService`/the workspace
 * config can override it once confirmed.
 */
export const DEFAULT_SAC_CODE = "998316";

/**
 * The prescribed endorsement for an export invoice raised under LUT without
 * payment of integrated tax (D41, RR-05 E2). Verbatim wording from
 * `04-pricing-and-monetization.md` v2 §Tax.
 */
export const LUT_EXPORT_ENDORSEMENT =
  "SUPPLY MEANT FOR EXPORT UNDER LUT WITHOUT PAYMENT OF INTEGRATED TAX";

/** Self-invoice (RCM import) endorsement — data-model support only (brief §1). */
export const RCM_SELF_INVOICE_NOTE =
  "TAX PAYABLE ON REVERSE CHARGE BASIS UNDER SECTION 5(3)/5(4) OF THE IGST ACT, 2017";

/** `06-data-model.md`: currency follows billing country; India is always INR. */
export const INDIA_COUNTRY = "IN";
