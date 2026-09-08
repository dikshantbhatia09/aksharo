/**
 * The one canonical list of spoken languages this product offers (K02).
 *
 * Before this file, the list was hand-duplicated in two places —
 * `language-picker.tsx`'s `QUICK_PICK_LANGUAGES` and `onboarding-flow.tsx`'s
 * `LANGUAGES` — with an explicit comment in each promising the other would
 * never drift. It did not drift in a way anyone noticed, but Nepali, Urdu and
 * Pushto were simply never added to either copy, because adding a language
 * meant remembering to touch two files. Now there is one list; both screens
 * import it.
 *
 * `group` drives the "Prepare Your Media" language combobox's sectioning
 * (K02 scope item 2, reference frame `frame_0040.png`): `"desi"` renders
 * first under a "Desi & Regional" heading, `"other"` after it. The grouping
 * is a presentational grouping only — it has no effect on transcription
 * routing, which reads `key` alone.
 */

export interface LanguageOption {
  readonly key: string;
  readonly label: string;
  readonly group: "desi" | "other";
  /** The English/romanized name, for search — most labels are in native script. */
  readonly english: string;
}

/**
 * Every language offered, spoken-language tag first. `key` is the BCP-47(-ish)
 * tag the transcribe request sends (`TranscribeRequestDto`'s `languages[]`,
 * `apps/api/src/transcripts/transcripts.dto.ts`); `label` is what a human
 * reads, in that language's own script where the product's fonts cover it.
 *
 * Order matters: within a group, this is the order the combobox renders
 * before a search narrows it. "Desi & Regional" carries the brief's own
 * example set (Hinglish, English, Bengali, Hindi, Marathi, Nepali) plus
 * English (India), which belongs next to English for the same reason the two
 * already sat together in the old flat list; everything else follows,
 * alphabetically by label.
 */
export const ALL_LANGUAGES: readonly LanguageOption[] = [
  // --- Desi & Regional ------------------------------------------------------
  { key: "hi-Latn", label: "Hinglish (Roman)", group: "desi", english: "Hinglish" },
  { key: "en-IN", label: "English (India)", group: "desi", english: "English India" },
  { key: "en", label: "English", group: "desi", english: "English" },
  { key: "bn", label: "বাংলা", group: "desi", english: "Bengali" },
  { key: "hi", label: "हिन्दी", group: "desi", english: "Hindi" },
  { key: "mr", label: "मराठी", group: "desi", english: "Marathi" },
  { key: "ne", label: "नेपाली", group: "desi", english: "Nepali" },
  // --- Everything else, alphabetically by label -----------------------------
  { key: "gu", label: "ગુજરાતી", group: "other", english: "Gujarati" },
  { key: "kn", label: "ಕನ್ನಡ", group: "other", english: "Kannada" },
  { key: "ml", label: "മലയാളം", group: "other", english: "Malayalam" },
  { key: "pa", label: "ਪੰਜਾਬੀ", group: "other", english: "Punjabi" },
  { key: "ps", label: "پښتو", group: "other", english: "Pushto" },
  { key: "ta", label: "தமிழ்", group: "other", english: "Tamil" },
  { key: "te", label: "తెలుగు", group: "other", english: "Telugu" },
  { key: "ur", label: "اردو", group: "other", english: "Urdu" },
] as const;

export const DESI_LANGUAGES: readonly LanguageOption[] = ALL_LANGUAGES.filter(
  (entry) => entry.group === "desi",
);
export const OTHER_LANGUAGES: readonly LanguageOption[] = ALL_LANGUAGES.filter(
  (entry) => entry.group === "other",
);

/** The display name for a tag, falling back to the tag itself. */
export function languageLabel(tag: string): string {
  return ALL_LANGUAGES.find((entry) => entry.key === tag)?.label ?? tag;
}
