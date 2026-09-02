/**
 * Bilingual hero copy for the home page (English / Hindi toggle).
 *
 * **Scope note.** The A24 brief's own "Out of scope" line says "localisation
 * beyond English (Hindi copy comes with B12/B17)", which reads as: no Hindi in
 * this WP. The task instructions this WP was actually given are more specific
 * and override that line: Hindi copy for the landing headline/subheads only,
 * "via the same ICU message setup A13 used (or add next-intl if absent and
 * report)". Reported as a conflict between the brief document and the task
 * instructions in the final report; the instructions were followed, kept to the
 * smallest defensible scope.
 *
 * **No ICU setup exists yet** (confirmed by search: no `next-intl`, no
 * `ICU`/`MessageFormat` anywhere in the repository — A13 did not add one).
 * `next-intl`'s App Router integration needs a `[locale]` segment restructure
 * of routing, `middleware.ts` and `next.config.ts` changes — all outside this
 * WP's file boundary (`apps/web/app/(site)/**`, `apps/web/content/site/**`,
 * `apps/web/public/**`, `CHANGELOG.md`) and a change that would touch A13's
 * auth pages, which sit in the same `(site)` group and are not this WP's to
 * redesign. So: a minimal local formatter implementing ICU MessageFormat's
 * simple-argument syntax (`{name}`) — enough for this hero's one interpolation
 * (the brand name) — with zero new dependencies and zero routing changes. A
 * dedicated i18n work package can replace `formatIcuLite` with `next-intl` or
 * `intl-messageformat` without changing `HERO_MESSAGES`' shape.
 */

import { BRAND } from "@montaj/config";

export type HeroLocale = "en" | "hi";

export interface HeroCopy {
  readonly kicker: string;
  readonly headline: string;
  readonly subheads: readonly string[];
  readonly cta: string;
  readonly ctaNote: string;
}

/** ICU MessageFormat's simple-argument syntax only: `{name}` → `values.name`. */
export function formatIcuLite(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? match) : match,
  );
}

const HERO_TEMPLATES: Record<HeroLocale, HeroCopy> = {
  en: {
    kicker: "{brand} — captions, cuts and polish, done inside your timeline",
    headline: "Captions that get how you actually speak.",
    subheads: [
      "Hinglish-accurate captions, every word editable, thirty styles built for Reels, Shorts and YouTube.",
      "Autocut, zoom and polish — proposals you accept in one click, inside your own timeline in Premiere, After Effects and Resolve.",
      "One plan for web, desktop and every plugin, priced in ₹, with a free clean export on us.",
    ],
    cta: "Start free — one clean export on us",
    ctaNote: "No card required. Your footage is never used to train anyone's AI.",
  },
  hi: {
    kicker: "{brand} — कैप्शन, कट और पॉलिश, आपकी टाइमलाइन के अंदर ही",
    headline: "कैप्शन जो आपकी असली बोलचाल समझते हैं।",
    subheads: [
      "Hinglish पर सटीक कैप्शन, हर शब्द एडिटेबल, Reels, Shorts और YouTube के लिए बने तीस स्टाइल्स।",
      "Autocut, zoom और पॉलिश — एक क्लिक में स्वीकार करें, अपनी ही टाइमलाइन में — Premiere, After Effects और Resolve में।",
      "वेब, डेस्कटॉप और हर प्लगइन के लिए एक ही प्लान, ₹ में, पहला क्लीन एक्सपोर्ट हमारी तरफ से फ्री।",
    ],
    cta: "फ्री शुरू करें — पहला क्लीन एक्सपोर्ट हमारी तरफ से",
    ctaNote: "कार्ड की ज़रूरत नहीं। आपकी फुटेज से कभी कोई AI ट्रेन नहीं होता।",
  },
};

export function heroCopy(locale: HeroLocale): HeroCopy {
  const copy = HERO_TEMPLATES[locale];
  return { ...copy, kicker: formatIcuLite(copy.kicker, { brand: BRAND.name }) };
}

export const HERO_LOCALE_LABEL: Record<HeroLocale, string> = {
  en: "EN",
  hi: "हिं",
};
