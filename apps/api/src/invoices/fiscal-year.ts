/**
 * Indian financial year: 1 April – 31 March (brief §2). `invoices.fiscalYear`
 * is `VarChar(9)` in the schema, wide enough for either the compact `26-27`
 * form the numbering scheme uses or a full `2026-2027` — this work package
 * always writes the compact form, matching the brief's own example
 * (`AK2627-IN-000123`).
 */

/** `"26-27"` for any date in FY 2026-27 (1 Apr 2026 – 31 Mar 2027). */
export function fiscalYearFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-based; 3 = April
  const startYear = month >= 3 ? year : year - 1;
  const endYear = (startYear + 1) % 100;
  return `${String(startYear % 100).padStart(2, "0")}-${String(endYear).padStart(2, "0")}`;
}

/** `"2026-04"`: the GSTR-1 filing period (calendar month) an invoice falls into. */
export function gstr1PeriodFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}
