/**
 * Indic UI fallbacks, loaded on demand (08 §1).
 *
 * Nine Noto families would be ~1.5 MB of webfont on a first paint that almost
 * nobody needs: the UI ships in English and Hindi, and a Tamil or Telugu glyph
 * only appears once a transcript in that script is on screen. So the families are
 * requested the first time a script is actually rendered, once per document, and
 * `document.fonts` decides when they arrive.
 */

/** The scripts the caption pipeline can produce native text in. */
export const INDIC_SCRIPTS = [
  "devanagari",
  "tamil",
  "bengali",
  "telugu",
  "kannada",
  "malayalam",
  "gujarati",
  "gurmukhi",
  "oriya",
] as const;

export type IndicScript = (typeof INDIC_SCRIPTS)[number];

/** Google Fonts family names, in the order the CSS font stack should try them. */
export const INDIC_FONT_FAMILIES: Record<IndicScript, string> = {
  devanagari: "Noto Sans Devanagari",
  tamil: "Noto Sans Tamil",
  bengali: "Noto Sans Bengali",
  telugu: "Noto Sans Telugu",
  kannada: "Noto Sans Kannada",
  malayalam: "Noto Sans Malayalam",
  gujarati: "Noto Sans Gujarati",
  gurmukhi: "Noto Sans Gurmukhi",
  oriya: "Noto Sans Oriya",
};

/** BCP-47 language subtags that need each script. `hi` → Devanagari, and so on. */
const LANGUAGE_SCRIPT: Record<string, IndicScript> = {
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
  sa: "devanagari",
  kok: "devanagari",
  mai: "devanagari",
  ta: "tamil",
  bn: "bengali",
  as: "bengali",
  te: "telugu",
  kn: "kannada",
  ml: "malayalam",
  gu: "gujarati",
  pa: "gurmukhi",
  or: "oriya",
};

/** The script a language tag is written in, or `undefined` for Latin. */
export function scriptForLanguage(language: string): IndicScript | undefined {
  const base = language.toLowerCase().split(/[-_]/)[0] ?? "";
  return LANGUAGE_SCRIPT[base];
}

/** The stylesheet URL for one family. Weights 400 and 600, `display=swap`. */
export function indicFontHref(script: IndicScript): string {
  const family = INDIC_FONT_FAMILIES[script].replace(/ /g, "+");
  return `https://fonts.googleapis.com/css2?family=${family}:wght@400;600&display=swap`;
}

const LINK_ID = (script: IndicScript): string => `aksharo-font-${script}`;

/**
 * Ensure the family for `script` is being loaded. Idempotent, and a no-op on the
 * server, so a component can call it from an effect without guarding.
 *
 * @returns `true` when this call inserted the stylesheet.
 */
export function loadIndicFont(script: IndicScript, doc?: Document): boolean {
  const target = doc ?? (typeof document === "undefined" ? undefined : document);
  if (target === undefined) return false;
  const id = LINK_ID(script);
  if (target.getElementById(id) !== null) return false;

  const link = target.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = indicFontHref(script);
  target.head.appendChild(link);
  return true;
}

/** The CSS `font-family` list for a language: its Noto family, then the UI stack. */
export function fontStackForLanguage(language: string): string {
  const script = scriptForLanguage(language);
  return script === undefined
    ? "var(--font-sans)"
    : `"${INDIC_FONT_FAMILIES[script]}", var(--font-sans)`;
}
