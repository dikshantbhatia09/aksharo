import { BRAND } from "@montaj/config";

/**
 * Supplier (Aksharo's own) identity for an invoice — brief §1: "supplier
 * details from `tax_registrations` and `BRAND`/entity config, never
 * hard-coded". `BRAND` (`packages/config/src/brand.ts`) has the product name
 * but no registered legal-entity details (address, PAN); GSTIN and LUT come
 * from `tax_registrations` (admin-editable, brief §6). What is left — the
 * legal name and registered-office address a real invoice must print — has no
 * home anywhere in the shipped data model, so it is read from environment
 * variables here rather than typed into a template.
 *
 * **Flagged for the accountant/company secretary [HUMAN]:** every default
 * below is an obvious placeholder (`SUPPLIER_ADDRESS_LINE1` defaults to a
 * string that SAYS it is not configured). Set the real registered-office
 * address, legal name and PAN via environment variables before the first real
 * invoice is issued. These are deliberately **not** added to
 * `docs/CONTRACTS.md` §1 (frozen for this work package) — they are optional,
 * non-contract variables read directly from `process.env`, the same pattern
 * `signature.service.ts` uses for `INVOICE_SIGNING_KEY`.
 */
export interface SupplierAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postalCode?: string;
  readonly country: string;
}

export interface SupplierConfig {
  readonly legalName: string;
  readonly address: SupplierAddress;
  readonly pan?: string;
}

export function resolveSupplierConfig(): SupplierConfig {
  const line2 = process.env["SUPPLIER_ADDRESS_LINE2"];
  const postalCode = process.env["SUPPLIER_ADDRESS_POSTAL_CODE"];
  const pan = process.env["SUPPLIER_PAN"];
  return {
    legalName: process.env["SUPPLIER_LEGAL_NAME"] ?? `${BRAND.name} Technologies Private Limited`,
    address: {
      line1:
        process.env["SUPPLIER_ADDRESS_LINE1"] ??
        "REGISTERED OFFICE ADDRESS NOT CONFIGURED (set SUPPLIER_ADDRESS_LINE1)",
      ...(line2 === undefined ? {} : { line2 }),
      city: process.env["SUPPLIER_ADDRESS_CITY"] ?? "Bengaluru",
      ...(postalCode === undefined ? {} : { postalCode }),
      country: "IN",
    },
    ...(pan === undefined ? {} : { pan }),
  };
}
