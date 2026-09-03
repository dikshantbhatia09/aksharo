/**
 * Minimal i18n layer for this panel — same shape and same reasoning as
 * `plugins/premiere-uxp/src/i18n/strings.ts` (no shared `packages/i18n` exists in this repo
 * yet; kept as this package's own copy rather than a `plugins/shared-ui` extraction, see
 * README "Shared UI").
 */

export type Locale = "en" | "hi";

export const DEFAULT_LOCALE: Locale = "en";

const STRINGS = {
  "signIn.title": { en: "Sign in", hi: "साइन इन करें" },
  "signIn.waiting": { en: "Waiting for approval…", hi: "स्वीकृति की प्रतीक्षा है…" },
  "signIn.codeLabel": {
    en: "Approve this device at the URL below:",
    hi: "इस डिवाइस को नीचे दिए गए URL पर स्वीकृत करें:",
  },
  "studio.required.title": {
    en: "Resolve Studio required",
    hi: "DaVinci Resolve Studio आवश्यक है",
  },
  "studio.required.body": {
    en: 'This panel needs DaVinci Resolve Studio. On Free, run "aksharo_core" from Workspace ▸ Scripts instead.',
    hi: 'इस पैनल के लिए DaVinci Resolve Studio चाहिए। Free में, Workspace ▸ Scripts से "aksharo_core" चलाएँ।',
  },
  "connection.waitingForScript": {
    en: "Waiting for the Aksharo script to start (Workspace ▸ Scripts ▸ aksharo_core)…",
    hi: "Aksharo स्क्रिप्ट शुरू होने की प्रतीक्षा (Workspace ▸ Scripts ▸ aksharo_core)…",
  },
  "connection.error": { en: "Could not connect: {message}", hi: "कनेक्ट नहीं हो सका: {message}" },
  "project.noTimeline": { en: "No timeline open", hi: "कोई टाइमलाइन खुली नहीं है" },
  "action.transcribe": { en: "Caption this timeline", hi: "इस टाइमलाइन को कैप्शन करें" },
  "action.applyInResolve": { en: "Apply in Resolve", hi: "Resolve में लागू करें" },
  "passes.title": { en: "Passes", hi: "पासेस" },
  "passes.empty": { en: "No passes yet", hi: "अभी कोई पास नहीं" },
  "status.mixing": { en: "Mixing down audio…", hi: "ऑडियो मिक्स हो रहा है…" },
  "status.uploading": { en: "Uploading…", hi: "अपलोड हो रहा है…" },
  "status.creating_project": { en: "Creating project…", hi: "प्रोजेक्ट बन रहा है…" },
  "status.done": { en: "Done", hi: "पूर्ण" },
  "status.error": { en: "Something went wrong: {message}", hi: "कुछ गलत हुआ: {message}" },
  "updateBanner.text": {
    en: "A newer panel version is available ({latest}). Yours: {current}.",
    hi: "एक नया पैनल संस्करण उपलब्ध है ({latest})। आपका: {current}।",
  },
  "footer.nonAffiliation": {
    en: "Aksharo is an independent product that works with DaVinci Resolve. It is not made, endorsed, or supported by Blackmagic Design.",
    hi: "Aksharo एक स्वतंत्र उत्पाद है जो DaVinci Resolve के साथ काम करता है। यह Blackmagic Design द्वारा निर्मित, अनुमोदित, या समर्थित नहीं है।",
  },
} as const satisfies Record<string, Record<Locale, string>>;

export type StringKey = keyof typeof STRINGS;

export function t(
  key: StringKey,
  vars: Record<string, string | number> = {},
  locale: Locale = DEFAULT_LOCALE,
): string {
  const template = STRINGS[key][locale];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
