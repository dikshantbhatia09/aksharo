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
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    Object.hasOwn(values, key) ? (values[key] ?? match) : match,
  );
}

const HERO_TEMPLATES: Record<HeroLocale, HeroCopy> = {
  en: {
    kicker: "{brand} — #1 AI viral video repurposing tool",
    headline: "1 long video, 10 viral clips. Create 10x faster.",
    subheads: [
      "Aksharo turns your long podcasts, YouTube videos, and webinars into high-retention shorts, reels, and TikToks with AI virality scoring and active speaker tracking.",
      "Autocut, auto-reframe, dynamic captions, and AI B-roll — accept proposals in one click with instant subtitle exports.",
      "One transparent credit pool, priced in ₹, with a free clean export on us.",
    ],
    cta: "Start free — one clean export on us",
    ctaNote: "No card required. Your footage is never used to train anyone's AI.",
  },
  hi: {
    kicker: "{brand} — #1 AI वायरल वीडियो रीपर्पसिंग टूल",
    headline: "1 लंबा वीडियो, 10 वायरल क्लिप्स। 10x तेज़ी से बनाएं।",
    subheads: [
      "Aksharo आपके लंबे पॉडकास्ट, YouTube वीडियो और वेबिनार को AI वायरल स्कोरिंग और एक्टिव स्पीकर ट्रैकिंग के साथ हाई-रिटेंशन शॉर्ट्स में बदलता है।",
      "Autocut, ऑटो-रीफ्रेम, डायनामिक कैप्शन्स और AI B-roll — एक क्लिक में स्वीकार करें, तुरंत सबटाइटल एक्सपोर्ट के साथ।",
      "एक ही पारदर्शी क्रेडिट पूल, ₹ में, पहला क्लीन एक्सपोर्ट हमारी तरफ से फ्री।",
    ],
    cta: "फ्री शुरू करें — पहला क्लीन एक्सपोर्ट हमारी तरफ से",
    ctaNote: "कार्ड की ज़रूरत नहीं। आपकी फुटेज से कभी कोई AI ट्रेन नहीं होता।",
  },
};

export function heroCopy(locale: HeroLocale): HeroCopy {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const copy = HERO_TEMPLATES[locale];
  return { ...copy, kicker: formatIcuLite(copy.kicker, { brand: BRAND.name }) };
}

export const HERO_LOCALE_LABEL: Record<HeroLocale, string> = {
  en: "EN",
  hi: "हिं",
};
