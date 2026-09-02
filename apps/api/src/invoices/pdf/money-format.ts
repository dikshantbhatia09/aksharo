import type { $Enums } from "@prisma/client";

/**
 * `69900` (paise) + `"INR"` -> `"Rs 699.00"`; `1900` (cents) + `"USD"` ->
 * `"$19.00"`.
 *
 * `"Rs "` rather than "₹": the PDF renderer uses only `pdfkit`'s built-in
 * standard fonts (no embedded font, brief §3 "headless-free"), and the
 * Rupee sign is outside WinAnsiEncoding — Helvetica silently substitutes an
 * unrelated glyph for it (confirmed while building the golden PDF tests). An
 * ASCII amount is unambiguous on every viewer and every text-extraction path,
 * which matters more for a legal document than the glyph.
 */
export function formatMoney(minor: number, currency: $Enums.Currency): string {
  const prefix = currency === "INR" ? "Rs " : "$";
  const major = minor / 100;
  return `${prefix}${major.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
