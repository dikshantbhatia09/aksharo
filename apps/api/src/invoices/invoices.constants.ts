import { BRAND } from "@montaj/config";

/**
 * Invoice numbering series (brief §2: "numbering per `(series, fiscalYear)`").
 *
 * Each is exactly 2 characters, which is what keeps the composed
 * `formatInvoiceNumber` output at 16 characters (see its doc-comment) —
 * `invoices.series` is `VarChar(8)` in the schema, generous headroom above
 * that. One Postgres sequence exists per `(series, fiscalYear)` pair
 * (`NumberingService`). A distinct series per document *kind* (rather than one
 * shared counter) is what keeps a credit note's numbering from perturbing the
 * tax-invoice sequence GSTR-1 reconciles against.
 *
 * `bill_of_supply` is `BS`, not the more obvious `BOS` — three characters
 * would make the composed number 17, one over Rule 46(b)'s cap (orchestrator
 * ruling, B05b).
 */
export const INVOICE_SERIES = {
  tax_invoice: "IN",
  export_invoice: "EX",
  bill_of_supply: "BS",
  credit_note: "CR",
  debit_note: "DR",
  self_invoice: "SI",
} as const;

export type InvoiceSeries = (typeof INVOICE_SERIES)[keyof typeof INVOICE_SERIES];

/**
 * The invoice number as stored in `invoices.number` AND as printed on the PDF
 * and reported to GSTR-1 — the same string, per the orchestrator's ruling
 * (B05b) on the brief's original `AKS/26-27/IN/000123` example, which was 19
 * characters against Rule 46(b)'s 16-character cap on the *whole* printed
 * serial number.
 *
 * New format: `AK{FY}-{SERIES}-{NNNNNN}` — e.g. `AK2627-IN-000123`:
 *
 * ```
 *   AK   2627  -  IN   -  000123
 *   ^^   ^^^^     ^^      ^^^^^^
 *   |    |        |       zero-padded sequence number (NumberingService)
 *   |    |        2-character series (INVOICE_SERIES)
 *   |    4-digit fiscal year, no separator ("26-27" -> "2627")
 *   brand prefix (BRAND.name's first two letters, upper-cased)
 * ```
 *
 * `2 + 4 + 1 + 2 + 1 + 6 = 16` characters exactly, satisfying
 * `prisma/sql/0003-checks.sql`'s `invoices_number_length_check` (`length(number)
 * BETWEEN 1 AND 16`) as Rule 46(b) actually intends: the constraint now binds
 * the full printed identifier, not a sub-part of it. The raw integer sequence
 * value is kept separately in `invoices.sequence_no` for anything that needs
 * the bare counter (the 200-parallel test, GSTR-1 tooling) without re-parsing
 * this string.
 */
const INVOICE_PREFIX = BRAND.name.slice(0, 2).toUpperCase();

export function formatInvoiceNumber(
  series: string,
  fiscalYear: string,
  sequenceNo: bigint | number,
): string {
  const fy4 = fiscalYear.replace("-", "");
  const padded = padSequence(sequenceNo);
  return `${INVOICE_PREFIX}${fy4}-${series}-${padded}`;
}

/** Zero-padded to 6 digits — generous headroom before the 16-character format above overflows. */
export function padSequence(value: bigint | number): string {
  return String(value).padStart(6, "0");
}
