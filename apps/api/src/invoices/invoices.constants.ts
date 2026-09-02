import { BRAND } from "@montaj/config";

/**
 * Invoice numbering series (brief §2: "numbering per `(series, fiscalYear)`").
 *
 * Each is ≤ 8 characters — `invoices.series` is `VarChar(8)` in the schema —
 * and one Postgres sequence exists per `(series, fiscalYear)` pair
 * (`NumberingService`). A distinct series per document *kind* (rather than one
 * shared counter) is what keeps a credit note's numbering from perturbing the
 * tax-invoice sequence GSTR-1 reconciles against.
 */
export const INVOICE_SERIES = {
  tax_invoice: "IN",
  export_invoice: "EX",
  bill_of_supply: "BOS",
  credit_note: "CR",
  debit_note: "DR",
  self_invoice: "SI",
} as const;

export type InvoiceSeries = (typeof INVOICE_SERIES)[keyof typeof INVOICE_SERIES];

/**
 * The human-readable invoice number as printed on the PDF and reported to
 * GSTR-1, e.g. `AKS/26-27/IN/000123` — the brief's own example format.
 *
 * **Flagged for the accountant (open question, see the work package report):**
 * `invoices.number` (the DB column Rule 46's ≤16-character cap is enforced
 * against, `prisma/sql/0003-checks.sql`'s `invoices_number_length_check`) holds
 * only the zero-padded sequential part (`"000123"`, 6 digits) — `series` and
 * `fiscalYear` are separate columns. This composed display string is 19
 * characters, longer than the brief's own "(≤ 16 chars)" annotation on the
 * example. Rule 46 itself caps the *whole* printed serial number at 16
 * characters; whether that literal cap is satisfied depends on reading the
 * printed identifier as `series/fiscalYear/number` (19 chars, as here — not
 * compliant on a literal reading) or as `invoices.number` alone (compliant by
 * construction, and what the shipped CHECK constraint actually enforces). This
 * work package could not resolve that reading without legal sign-off, so it
 * implements the schema's own literal constraint (the `number` column) and
 * surfaces the full composed string for human/GSTR-1 legibility; a CA must
 * confirm before the first real invoice is issued.
 */
const INVOICE_PREFIX = BRAND.name.slice(0, 3).toUpperCase();

export function formatInvoiceNumber(series: string, fiscalYear: string, number: string): string {
  return `${INVOICE_PREFIX}/${fiscalYear}/${series}/${number}`;
}

/** Zero-padded to 6 digits — generous headroom under the schema's `VarChar(16)`. */
export function padSequence(value: bigint | number): string {
  return String(value).padStart(6, "0");
}
