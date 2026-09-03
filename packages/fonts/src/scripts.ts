/**
 * Scripts, the languages that need them, and the code points each one covers.
 *
 * Two script vocabularies meet here and they are deliberately kept apart:
 *
 * - **ISO 15924 tags** (`Deva`, `Beng`, `Mtei`) are what the catalogue talks in.
 *   A font pipeline has to distinguish Bengali from Odia from Meetei Mayek, and
 *   a coverage claim is only checkable against a real code-point range.
 * - **`WordScript`** (`latin | devanagari | tamil | other`) is the frozen
 *   segmenter vocabulary `@montaj/edg` owns and `FontRegistry` resolves by. It
 *   is a *layout* alphabet — it names the scripts whose line-breaking and budget
 *   rules differ — not a repertoire.
 *
 * So a manifest entry carries both: `scriptTags` for the catalogue and coverage
 * tests, `scripts` for the registry hint. {@link toWordScript} is the only place
 * the two are joined, and it never widens `WordScript`: everything that is not
 * Latin, Devanagari or Tamil is `other`, exactly as the segmenter says.
 */

import { type WordScript } from "@montaj/render-core";

/** ISO 15924 tags the bundled catalogue uses. */
export const SCRIPT_TAGS = [
  "Latn",
  "Deva",
  "Beng",
  "Guru",
  "Gujr",
  "Orya",
  "Taml",
  "Telu",
  "Knda",
  "Mlym",
  "Olck",
  "Mtei",
  "Arab",
] as const;

export type ScriptTag = (typeof SCRIPT_TAGS)[number];

const SCRIPT_TAG_SET: ReadonlySet<string> = new Set<string>(SCRIPT_TAGS);

export function isScriptTag(value: unknown): value is ScriptTag {
  return typeof value === "string" && SCRIPT_TAG_SET.has(value);
}

/** Human name for a tag, for the catalogue UI and the report. */
export const SCRIPT_NAMES: Readonly<Record<ScriptTag, string>> = {
  Latn: "Latin",
  Deva: "Devanagari",
  Beng: "Bengali",
  Guru: "Gurmukhi",
  Gujr: "Gujarati",
  Orya: "Odia",
  Taml: "Tamil",
  Telu: "Telugu",
  Knda: "Kannada",
  Mlym: "Malayalam",
  Olck: "Ol Chiki",
  Mtei: "Meetei Mayek",
  Arab: "Arabic",
};

/** An inclusive `[first, last]` code-point range. */
export type CodePointRange = readonly [number, number];

/**
 * Punctuation, digits and marks every face must keep whatever script it is for.
 *
 * A caption is never pure script: it has spaces, a full stop, a digit, a rupee
 * sign, and a ZWJ/ZWNJ pair that Indic shaping depends on. Subsetting these away
 * would make a Devanagari face fall back to Latin mid-word, which is exactly the
 * tofu the itemiser exists to prevent.
 */
export const COMMON_RANGES: readonly CodePointRange[] = [
  [0x0020, 0x007e], // Basic Latin: space, digits, ASCII punctuation
  [0x00a0, 0x00ff], // Latin-1 supplement (©, ×, accented Latin)
  [0x200c, 0x200d], // ZWNJ, ZWJ — Indic shaping controls
  [0x2010, 0x2015], // hyphens and dashes
  [0x2018, 0x201d], // curly quotes
  [0x2020, 0x2022], // dagger, bullet
  [0x2026, 0x2026], // ellipsis
  [0x20b9, 0x20b9], // ₹
  [0x20ac, 0x20ac], // €
  [0x2122, 0x2122], // ™
];

/**
 * The code points that define a script, for subsetting and for checking a
 * coverage claim.
 *
 * These are the Unicode blocks, not "every code point a font happens to have":
 * a face claiming `Deva` is asked to cover the *consonants and vowels* of
 * Devanagari, not the Vedic extensions no caption will ever contain. The
 * required set each claim is judged against is {@link REQUIRED_CODE_POINTS}.
 */
export const SCRIPT_RANGES: Readonly<Record<ScriptTag, readonly CodePointRange[]>> = {
  Latn: [
    [0x0020, 0x007e],
    [0x00a0, 0x017f],
    [0x0180, 0x024f],
  ],
  Deva: [
    [0x0900, 0x097f],
    [0x1cd0, 0x1cf9],
    [0xa8e0, 0xa8ff],
  ],
  Beng: [[0x0980, 0x09ff]],
  Guru: [[0x0a00, 0x0a7f]],
  Gujr: [[0x0a80, 0x0aff]],
  Orya: [[0x0b00, 0x0b7f]],
  Taml: [
    [0x0b80, 0x0bff],
    [0x11fc0, 0x11ff1],
  ],
  Telu: [[0x0c00, 0x0c7f]],
  Knda: [[0x0c80, 0x0cff]],
  Mlym: [[0x0d00, 0x0d7f]],
  Olck: [[0x1c50, 0x1c7f]],
  Mtei: [
    [0xabc0, 0xabff],
    [0xaae0, 0xaaf6],
  ],
  Arab: [
    [0x0600, 0x06ff],
    [0x0750, 0x077f],
    [0x08a0, 0x08ff],
    [0xfb50, 0xfdff],
    [0xfe70, 0xfeff],
  ],
};

/**
 * The code points a face **must** have to be allowed to claim a script.
 *
 * Deliberately much smaller than {@link SCRIPT_RANGES}: a Unicode block contains
 * unassigned positions and historic characters no shipped font covers, so
 * demanding the whole block would reject every real font. These are the letters
 * a caption in the script cannot be written without — so a font that claims
 * `Taml` and has no Tamil letters is rejected, and a font that merely lacks
 * `U+0B9B` is not.
 */
export const REQUIRED_CODE_POINTS: Readonly<Record<ScriptTag, readonly CodePointRange[]>> = {
  Latn: [
    [0x0041, 0x005a],
    [0x0061, 0x007a],
    [0x0030, 0x0039],
  ],
  Deva: [
    [0x0905, 0x0939],
    [0x093e, 0x094d],
  ],
  Beng: [
    [0x0985, 0x098c],
    [0x0995, 0x09a8],
    [0x09be, 0x09c4],
  ],
  Guru: [
    [0x0a05, 0x0a0a],
    [0x0a15, 0x0a28],
  ],
  Gujr: [
    [0x0a85, 0x0a8b],
    [0x0a95, 0x0aa8],
  ],
  Orya: [
    [0x0b05, 0x0b0c],
    [0x0b15, 0x0b28],
  ],
  Taml: [
    [0x0b85, 0x0b8a],
    [0x0b95, 0x0b95],
    [0x0b99, 0x0b9a],
    [0x0b9e, 0x0b9f],
    [0x0ba3, 0x0ba4],
    [0x0ba8, 0x0baa],
    [0x0bae, 0x0bb9],
  ],
  Telu: [
    [0x0c05, 0x0c0c],
    [0x0c15, 0x0c28],
  ],
  Knda: [
    [0x0c85, 0x0c8c],
    [0x0c95, 0x0ca8],
  ],
  Mlym: [
    [0x0d05, 0x0d0c],
    [0x0d15, 0x0d28],
  ],
  Olck: [[0x1c5a, 0x1c77]],
  Mtei: [[0xabc0, 0xabe2]],
  Arab: [
    [0x0621, 0x063a],
    [0x0641, 0x064a],
  ],
};

/**
 * A language on the Eighth Schedule of the Constitution of India, with the
 * script Aksharo draws it in.
 *
 * These are the 22 scheduled languages `08 §1` promises the caption catalogue
 * renders. The list is the acceptance criterion for the bundle: every script
 * named here has to be covered by a bundled family, and `catalogue.test.ts`
 * checks that against the shipped faces' own character maps rather than against
 * a claim in a table.
 */
export interface ScheduledLanguage {
  /** BCP-47 primary subtag. */
  readonly code: string;
  readonly name: string;
  readonly script: ScriptTag;
}

export const SCHEDULED_LANGUAGES: readonly ScheduledLanguage[] = [
  { code: "as", name: "Assamese", script: "Beng" },
  { code: "bn", name: "Bengali", script: "Beng" },
  { code: "brx", name: "Bodo", script: "Deva" },
  { code: "doi", name: "Dogri", script: "Deva" },
  { code: "gu", name: "Gujarati", script: "Gujr" },
  { code: "hi", name: "Hindi", script: "Deva" },
  { code: "kn", name: "Kannada", script: "Knda" },
  { code: "ks", name: "Kashmiri", script: "Arab" },
  { code: "kok", name: "Konkani", script: "Deva" },
  { code: "mai", name: "Maithili", script: "Deva" },
  { code: "ml", name: "Malayalam", script: "Mlym" },
  { code: "mni", name: "Manipuri", script: "Mtei" },
  { code: "mr", name: "Marathi", script: "Deva" },
  { code: "ne", name: "Nepali", script: "Deva" },
  { code: "or", name: "Odia", script: "Orya" },
  { code: "pa", name: "Punjabi", script: "Guru" },
  { code: "sa", name: "Sanskrit", script: "Deva" },
  { code: "sat", name: "Santali", script: "Olck" },
  { code: "sd", name: "Sindhi", script: "Arab" },
  { code: "ta", name: "Tamil", script: "Taml" },
  { code: "te", name: "Telugu", script: "Telu" },
  { code: "ur", name: "Urdu", script: "Arab" },
];

/**
 * Every script the bundle must cover: the 22 scheduled languages' scripts plus
 * Latin, which every project needs for English, romanised Hinglish and digits.
 */
export const REQUIRED_SCRIPTS: readonly ScriptTag[] = [
  "Latn",
  ...new Set(SCHEDULED_LANGUAGES.map((language) => language.script)),
];

/**
 * The `WordScript` a registry entry should advertise for an ISO tag.
 *
 * Narrowing, never widening: `WordScript` is `@montaj/edg`'s frozen segmenter
 * type and everything outside Latin/Devanagari/Tamil is `other` there, so a
 * Bengali face registers as `other` and is still found — by family, by the
 * style's fallbacks, or by covering the code points.
 */
export function toWordScript(tag: ScriptTag): WordScript {
  switch (tag) {
    case "Latn":
      return "latin";
    case "Deva":
      return "devanagari";
    case "Taml":
      return "tamil";
    default:
      return "other";
  }
}

/** The distinct `WordScript` hints for a set of tags, in a stable order. */
export function toWordScripts(tags: readonly ScriptTag[]): WordScript[] {
  const order: readonly WordScript[] = ["latin", "devanagari", "tamil", "other"];
  const found = new Set(tags.map(toWordScript));
  return order.filter((script) => found.has(script));
}

/** Expand ranges to a sorted, de-duplicated code-point array. */
export function expandRanges(ranges: readonly CodePointRange[]): number[] {
  const points = new Set<number>();
  for (const [first, last] of ranges) {
    for (let code = first; code <= last; code += 1) points.add(code);
  }
  return [...points].sort((a, b) => a - b);
}

/** The code points to keep when subsetting for `tags` (always plus the common set). */
export function subsetCodePoints(tags: readonly ScriptTag[]): number[] {
  const ranges: CodePointRange[] = [...COMMON_RANGES];
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  for (const tag of tags) ranges.push(...SCRIPT_RANGES[tag]);
  return expandRanges(ranges);
}

/**
 * The same set as a string, which is what `hb-subset` takes.
 *
 * Lone surrogates would be produced by naive `fromCharCode`, so this goes
 * through `fromCodePoint` and skips the surrogate range itself.
 */
export function subsetText(tags: readonly ScriptTag[]): string {
  let text = "";
  for (const code of subsetCodePoints(tags)) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    text += String.fromCodePoint(code);
  }
  return text;
}

/** The code points a face must cover to be allowed to claim `tag`. */
export function requiredCodePoints(tag: ScriptTag): number[] {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  return expandRanges(REQUIRED_CODE_POINTS[tag]);
}

/** The tags whose blocks contain `code`, for "what is this font actually for". */
export function scriptsOfCodePoint(code: number): ScriptTag[] {
  return SCRIPT_TAGS.filter((tag) =>
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    SCRIPT_RANGES[tag].some(([first, last]) => code >= first && code <= last),
  );
}

/**
 * The scripts a character map actually covers, judged by the same rule a claim
 * is judged by: at least 90% of the script's required code points are present.
 *
 * The threshold is not 100% because a real shipped font legitimately omits a
 * character or two from a block (Noto Sans Tamil has no `U+0B9B`), and it is not
 * 50% because a Latin font with a handful of Devanagari digits must not be able
 * to call itself a Devanagari font.
 */
export const COVERAGE_THRESHOLD = 0.9;

export function coveredScripts(codePoints: ReadonlySet<number>): ScriptTag[] {
  return SCRIPT_TAGS.filter((tag) => coverageRatio(tag, codePoints) >= COVERAGE_THRESHOLD);
}

/** How much of `tag`'s required repertoire a character map has, in `[0, 1]`. */
export function coverageRatio(tag: ScriptTag, codePoints: ReadonlySet<number>): number {
  const required = requiredCodePoints(tag);
  if (required.length === 0) return 1;
  let present = 0;
  for (const code of required) if (codePoints.has(code)) present += 1;
  return present / required.length;
}

/** A short sample of the script, for shaping smoke tests and previews. */
export const SCRIPT_SAMPLES: Readonly<Record<ScriptTag, string>> = {
  Latn: "The quick brown fox",
  Deva: "हिंदी में कैप्शन",
  Beng: "বাংলা ক্যাপশন",
  Guru: "ਪੰਜਾਬੀ ਕੈਪਸ਼ਨ",
  Gujr: "ગુજરાતી કૅપ્શન",
  Orya: "ଓଡ଼ିଆ କ୍ୟାପସନ",
  Taml: "தமிழ் வசனம்",
  Telu: "తెలుగు క్యాప్షన్",
  Knda: "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ",
  Mlym: "മലയാളം അടിക്കുറിപ്പ്",
  Olck: "ᱥᱟᱱᱛᱟᱲᱤ",
  Mtei: "ꯃꯤꯇꯩ ꯂꯣꯟ",
  Arab: "اردو سرخی",
};
