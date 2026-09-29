import { DUB_LANGUAGES, DUB_LANGUAGE_NAMES, type DubLanguage } from "@montaj/repurpose-contracts";

/**
 * The product's language tags and the dubbing vendor's codes (2026-10-04).
 *
 * The product speaks ISO 639-1 (`hi`, `ta`), with `hi-Latn` for Hinglish and
 * the occasional region (`en-IN`); Sarvam's dubbing speaks `<code>-IN` for
 * twelve languages, with Odia as `or-IN`. Hinglish is Hindi to the vendor: the
 * speech is Hindi with English in it, and the dub of it is a dub of Hindi.
 */

/** Every spelling of Hindi-English code-mix the product or a vendor uses. */
const CODE_MIX = new Set(["hinglish", "hi-latn", "hin-latn", "hi-en", "hi_en", "en-hi"]);

/** Base tags to the vendor's codes. `od` is how Sarvam's speech-to-text spells Odia. */
const VENDOR_CODE: ReadonlyMap<string, DubLanguage> = new Map<string, DubLanguage>([
  ["en", "en-IN"],
  ["hi", "hi-IN"],
  ["bn", "bn-IN"],
  ["gu", "gu-IN"],
  ["kn", "kn-IN"],
  ["ml", "ml-IN"],
  ["mr", "mr-IN"],
  ["or", "or-IN"],
  ["od", "or-IN"],
  ["pa", "pa-IN"],
  ["ta", "ta-IN"],
  ["te", "te-IN"],
  ["as", "as-IN"],
]);

/**
 * The vendor's code for a product language tag, or `null` when it cannot dub
 * from it (an undetected language, one Sarvam does not dub, `auto`).
 */
export function vendorLanguageOf(tag: string | null | undefined): DubLanguage | null {
  if (typeof tag !== "string") return null;
  const normalised = tag.trim().toLowerCase();
  if (normalised === "") return null;
  if (CODE_MIX.has(normalised)) return "hi-IN";
  const base = normalised.split(/[-_]/)[0] ?? "";
  return VENDOR_CODE.get(base) ?? null;
}

/** The product tag a dubbed project's transcript and captions are written in: `hi-IN` → `hi`. */
export function productLanguageOf(code: DubLanguage): string {
  return code.slice(0, 2);
}

/** Whether a string is one of the vendor's codes. */
export function isDubLanguage(value: string): value is DubLanguage {
  return (DUB_LANGUAGES as readonly string[]).includes(value);
}

/** A language as the page shows it. */
export interface DubLanguageOption {
  readonly code: DubLanguage;
  readonly name: string;
}

export function dubLanguageOption(code: DubLanguage): DubLanguageOption {
  // eslint-disable-next-line security/detect-object-injection -- a closed enum of codes
  return { code, name: DUB_LANGUAGE_NAMES[code] };
}

/** Every language a clip can be dubbed into, in the vendor's order. */
export const DUB_LANGUAGE_OPTIONS: readonly DubLanguageOption[] = DUB_LANGUAGES.map((code) =>
  dubLanguageOption(code),
);
