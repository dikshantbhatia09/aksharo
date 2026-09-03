/**
 * Minimal i18n layer for this panel. `03-architecture` B17 (onboarding language defaults) has
 * not landed a shared `packages/i18n` at the time this package was built (checked: no
 * `packages/i18n*` directory exists in this repo) — the brief allows "the panel's own copy of
 * the pattern" in that case, so this is a small, self-contained key -> {en, hi} dictionary and
 * a `t()` lookup. If `packages/i18n` lands later, this file's shape (flat keys, `t(key, vars?)`
 * with `{placeholder}` interpolation) is deliberately close to what a shared package would
 * look like, to make migrating call sites a rename rather than a rewrite.
 */

export type Locale = "en" | "hi";

export const DEFAULT_LOCALE: Locale = "en";

/** B17 default language hints for transcription (Hinglish-first per 08 §Onboarding). */
export const LANGUAGE_HINTS: readonly { code: string; label: string }[] = [
  { code: "hi-Latn", label: "Hinglish (Roman)" },
  { code: "hi", label: "Hindi" },
  { code: "en-IN", label: "English (India)" },
  { code: "en", label: "English" },
];

const STRINGS = {
  "signIn.title": { en: "Sign in", hi: "साइन इन करें" },
  "signIn.cta": { en: "Sign in with Aksharo", hi: "Aksharo से साइन इन करें" },
  "signIn.waiting": { en: "Waiting for approval…", hi: "स्वीकृति की प्रतीक्षा है…" },
  "signIn.codeLabel": {
    en: "Can't open a browser? Enter this code:",
    hi: "ब्राउज़र नहीं खुला? यह कोड डालें:",
  },
  "signIn.codeInputLabel": { en: "Enter pairing code", hi: "पेयरिंग कोड डालें" },
  "signIn.approve": { en: "I approved it", hi: "मैंने स्वीकृत कर दिया" },
  "signIn.signOut": { en: "Sign out", hi: "साइन आउट करें" },
  "signIn.error": { en: "Sign-in failed: {message}", hi: "साइन-इन विफल: {message}" },
  "source.noSequence": { en: "No sequence open", hi: "कोई सीक्वेंस खुला नहीं है" },
  "source.inOut": { en: "In/Out: {duration}", hi: "इन/आउट: {duration}" },
  "source.audioOnly": { en: "Audio-only mixdown", hi: "केवल-ऑडियो मिक्सडाउन" },
  "action.transcribe": { en: "Transcribe this sequence", hi: "इस सीक्वेंस को ट्रांसक्राइब करें" },
  "action.openInWeb": { en: "Open in the web editor", hi: "वेब एडिटर में खोलें" },
  "status.uploading": {
    en: "Uploading audio… {percent}%",
    hi: "ऑडियो अपलोड हो रहा है… {percent}%",
  },
  "status.transcribing": { en: "Transcribing…", hi: "ट्रांसक्राइब हो रहा है…" },
  "status.done": { en: "Done", hi: "पूर्ण" },
  "status.error": { en: "Something went wrong: {message}", hi: "कुछ गलत हुआ: {message}" },
  "updateBanner.text": {
    en: "A newer panel version is available ({latest}). Yours: {current}.",
    hi: "एक नया पैनल संस्करण उपलब्ध है ({latest})। आपका: {current}।",
  },
  "footer.nonAffiliation": {
    en: "Adobe, Premiere Pro and After Effects are trademarks of Adobe Inc. Aksharo is not affiliated with or endorsed by Adobe.",
    hi: "Adobe, Premiere Pro और After Effects, Adobe Inc. के ट्रेडमार्क हैं। Aksharo, Adobe से संबद्ध या अनुमोदित नहीं है।",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type StringKey = keyof typeof STRINGS;

export function t(
  key: StringKey,
  vars: Record<string, string | number> = {},
  locale: Locale = DEFAULT_LOCALE,
): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const table = STRINGS[key];
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const template = table[locale] ?? table[DEFAULT_LOCALE];
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}
