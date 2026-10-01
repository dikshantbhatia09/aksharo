/**
 * What a voice-over costs (2026-10-01): the person in credits, the product in
 * rupees.
 *
 * The vendor (Sarvam's text-to-speech, `bulbul:v3`; its published price on
 * 2026-10-01, to be confirmed on the account's first invoice) charges ₹30 per
 * 10,000 characters. A hook is at most 300 characters, so one voice-over costs
 * the product under a rupee.
 *
 * A person is charged a flat {@link VOICEOVER_TENTHS} (2 credits) per
 * voice-over, whatever its length: at the cheapest credit (Rs 1.11 on Studio)
 * that is about Rs 2.2, which covers the vendor many times over and also pays
 * for the captioned videos being made again with the voice in them (those are
 * charged on their own, at the cloud render rate, as any render is). A flat
 * price is also the one a person can read before asking: "2 credits".
 *
 * A constant here, not a `BURN_RATES` row, for the reason `dub-pricing.ts`
 * gives: a burn rate becomes every plan's entitlement, and this is switched on
 * per workspace by its flag.
 */

/** 2 credits a voice-over, in tenths. */
export const VOICEOVER_TENTHS = 20;

/** ₹30 per 10,000 characters, in paise: the vendor's price. */
export const VOICEOVER_VENDOR_PAISE_PER_10K_CHARACTERS = 3_000;

/** What the vendor charges for `characters` characters, in paise, rounded up. */
export function voiceoverVendorPaise(characters: number): number {
  const count = Number.isFinite(characters) ? Math.max(0, Math.floor(characters)) : 0;
  return Math.ceil((count * VOICEOVER_VENDOR_PAISE_PER_10K_CHARACTERS) / 10_000);
}
