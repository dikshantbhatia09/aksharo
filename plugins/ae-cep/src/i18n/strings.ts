/**
 * Minimal i18n layer for this panel — same shape `plugins/premiere-uxp/src/i18n/strings.ts`
 * (C05a) uses; no shared `packages/i18n` exists in this repo yet (checked again for this WP).
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
  "comp.noComp": { en: "No composition open", hi: "कोई कंपोज़िशन खुला नहीं है" },
  "comp.workArea": { en: "Work area: {duration}", hi: "वर्क एरिया: {duration}" },
  "comp.audioOnly": { en: "Audio-only mixdown", hi: "केवल-ऑडियो मिक्सडाउन" },
  "action.caption": { en: "Caption this comp", hi: "इस कंप को कैप्शन करें" },
  "action.apply": { en: "Apply captions", hi: "कैप्शन लागू करें" },
  "action.openInWeb": { en: "Open in the web editor", hi: "वेब एडिटर में खोलें" },
  "applyMode.styledText": { en: "Styled text layers", hi: "स्टाइल्ड टेक्स्ट लेयर्स" },
  "applyMode.overlay": { en: "Alpha overlay", hi: "अल्फा ओवरले" },
  "status.uploading": {
    en: "Uploading audio… {percent}%",
    hi: "ऑडियो अपलोड हो रहा है… {percent}%",
  },
  "status.transcribing": { en: "Transcribing…", hi: "ट्रांसक्राइब हो रहा है…" },
  "status.done": { en: "Done", hi: "पूर्ण" },
  "status.error": { en: "Something went wrong: {message}", hi: "कुछ गलत हुआ: {message}" },
  "footer.nonAffiliation": {
    en: "Adobe and After Effects are trademarks of Adobe Inc. Aksharo is not affiliated with or endorsed by Adobe.",
    hi: "Adobe और After Effects, Adobe Inc. के ट्रेडमार्क हैं। Aksharo, Adobe से संबद्ध या अनुमोदित नहीं है।",
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
