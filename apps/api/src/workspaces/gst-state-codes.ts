/**
 * The GST State codes of India.
 *
 * D41 makes the State a **mandatory validated field** for every Indian purchase
 * (Circular 242/36/2024-GST): it is the address on record that fixes the place of
 * supply, so an unvalidated free-text state is a wrong invoice.
 *
 * The list is the 36 live jurisdictions — 28 States and 8 Union Territories —
 * with the two-digit codes of the GST State Code list (the first two digits of a
 * GSTIN). Three codes that appear in older tables are deliberately **absent**,
 * because a customer cannot be in them today:
 *
 *   * `25` Daman and Diu — merged into `26` on 2020-01-26;
 *   * `28` Andhra Pradesh — replaced by `37` after the 2014 bifurcation;
 *   * `97` Other Territory and `99` Centre Jurisdiction — administrative buckets
 *     the GST portal uses for its own records, never a customer address.
 *
 * A workspace that genuinely needs one of those is a support conversation, not a
 * silent pass through validation.
 */

export interface GstState {
  /** Two digits, zero-padded; matches the first two characters of a GSTIN. */
  readonly code: string;
  readonly name: string;
  readonly type: "state" | "union_territory";
}

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

/** `true` when `code` is one of the 36 live GST State codes. */
export function isGstStateCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** The State a code names, or `undefined`. */
export function gstState(code: string): GstState | undefined {
  return BY_CODE.get(code);
}
