/**
 * Comparison pages data (`/vs/[slug]`), 13-launch-plan.md "Comparison SEO":
 * `/vs/kalakar`, `/vs/captik`, `/vs/submagic`, `/vs/autocut`, "dated price
 * tables and honest capability notes."
 *
 * Every fact below is transcribed from
 * `03-architecture/01-competitive-analysis.md` (§1 Kalakar, §2 Captik, §7
 * additional competitors), never invented for this page. That document states
 * its own verification date for the §7 entries — "Live checks confirmed every
 * Kalakar, Captik and Pause price above" — 2 September 2026, which is the
 * `verifiedOn` date below unless a fact carries its own citation.
 *
 * `sourceUrl` points at the competitor's own site where the source document
 * gives an explicit domain (Kalakar, Captik); Submagic and AutoCut are named in
 * the source document without a verified domain attached, so rather than guess
 * one, `sourceUrl` is omitted and `sourceLabel` cites the internal research
 * document instead — a claim this page makes is always attributable to a dated
 * source, even where that source is our own research rather than a live link.
 */

const VERIFIED_ON = "2026-09-02";
const RESEARCH_DOC = "03-architecture/01-competitive-analysis.md";

export interface ComparisonFact {
  readonly label: string;
  readonly them: string;
  readonly us: string;
}

export interface ComparisonPage {
  readonly slug: string;
  readonly competitorName: string;
  readonly sourceUrl?: string;
  readonly sourceLabel: string;
  readonly verifiedOn: string;
  readonly summary: string;
  readonly facts: readonly ComparisonFact[];
  readonly weaknessesNoted: readonly string[];
}

export const COMPARISON_PAGES: readonly ComparisonPage[] = [
  {
    slug: "kalakar",
    competitorName: "Kalakar",
    sourceUrl: "https://app.kalakar.io",
    sourceLabel: `${RESEARCH_DOC} §1`,
    verifiedOn: VERIFIED_ON,
    summary:
      "Kalakar covers web, a desktop wrapper and two NLE plugins with a strong Academy and an aggressive affiliate programme. Its plugins are billed as a second subscription on top of the web plan, and every plan carries a hard per-video length cap.",
    facts: [
      {
        label: "Premiere Pro / Resolve plugin pricing",
        them: "₹950/month each, separate from the web plan (Creator ₹950/mo).",
        us: "One credit pool for web, desktop and every plugin — no second subscription.",
      },
      {
        label: "Per-video length cap",
        them: "2 min (Editor), 5 min (Creator), 30 min (Studio).",
        us: "No per-video length cap on paid plans; limits are by file size and duration ceiling per plan, not per clip.",
      },
      {
        label: "Desktop app",
        them: "Electron wrapper around the web app; no local transcription or render.",
        us: "A native local engine (on-device transcription, audio clean, render) for zero-upload workflows.",
      },
      {
        label: "Indic / Hinglish accuracy claim",
        them: "Implied by language routing; no published code-mixed error rate.",
        us: "A published Hinglish and per-language word error rate on a named public eval set.",
      },
      {
        label: "Loyalty programme",
        them: '"Aura": publish 5 days a week for 4 weeks to level up, up to 30% off.',
        us: "A publish-day streak with a lower bar (3 days/week) and auto-applied freezes so a missed week does not reset progress.",
      },
    ],
    weaknessesNoted: [
      "Plugins sold separately from the web plan (₹950 each).",
      "Tight per-video length caps (2/5/10/30 min).",
      "Desktop app has no local processing — it is the web app in an Electron wrapper.",
      "Free tier is effectively a 5-minute trial.",
    ],
  },
  {
    slug: "captik",
    competitorName: "Captik",
    sourceUrl: "https://captik.in/pricing",
    sourceLabel: `${RESEARCH_DOC} §2`,
    verifiedOn: VERIFIED_ON,
    summary:
      "Captik is the sharpest positioning we found on Hinglish and browser-native, zero-upload export, with a real micro-pricing ladder. Its free and Starter quotas are very small, it has no desktop app, and it ships no auto-editing.",
    facts: [
      {
        label: "Free plan transcription quota",
        them: "2–3 minutes a month.",
        us: "20 credits (20 minutes) a month, plus one free clean export on signup.",
      },
      {
        label: "Starter plan quota",
        them: "₹299/mo — 60 minutes transcription/month.",
        us: "₹299/mo Starter — 150 credits (150 minutes) a month.",
      },
      {
        label: "Auto-editing (autocut, zoom)",
        them: "Not offered.",
        us: "Autocut and Reframe & Zoom passes from Creator, with a reviewable proposal for every change.",
      },
      {
        label: "Desktop app / local processing",
        them: "None — browser only.",
        us: "A desktop app with local, zero-upload transcription and render.",
      },
      {
        label: "NLE plugin coverage",
        them: "Premiere Pro, After Effects panel, plus a Resolve panel/script.",
        us: "Premiere Pro (UXP), After Effects (CEP) and DaVinci Resolve, drawing on the same credit pool as web and desktop.",
      },
    ],
    weaknessesNoted: [
      "Very small quotas (2–3 min free, 60 min Starter).",
      "No desktop app.",
      "No auto-editing (autocut, zoom).",
      "Single active device per plan.",
    ],
  },
  {
    slug: "submagic",
    competitorName: "Submagic",
    sourceLabel: `${RESEARCH_DOC} §7`,
    verifiedOn: VERIFIED_ON,
    summary:
      "Submagic is a USD-only, affiliate-led captioning tool with no NLE plugin and per-video length caps on every plan. It has no Indic language routing and no INR pricing.",
    facts: [
      {
        label: "Pricing",
        them: "$19 / $39 / $69 per month (yearly $12 / $23 / $41); no INR pricing.",
        us: "₹ pricing by default with a USD toggle, UPI Autopay, and a ₹9 first export before any subscription.",
      },
      {
        label: "Per-video length cap",
        them: "2 / 5 / 30 minutes depending on plan.",
        us: "No per-video length cap on paid plans.",
      },
      {
        label: "NLE plugin",
        them: "None — browser only.",
        us: "Premiere Pro (UXP), After Effects (CEP) and DaVinci Resolve plugins on the same account.",
      },
      {
        label: "Indic / Hinglish language support",
        them: "Not a stated focus.",
        us: "Hindi, 21 other Indian languages and 90+ global languages, each routed to the best-performing model.",
      },
    ],
    weaknessesNoted: [
      "USD only — no INR pricing or India payment rails.",
      "No NLE plugin.",
      "Per-video caps on every plan (2/5/30 min).",
    ],
  },
  {
    slug: "autocut",
    competitorName: "AutoCut",
    sourceLabel: `${RESEARCH_DOC} §7`,
    verifiedOn: VERIFIED_ON,
    summary:
      "AutoCut is the real price anchor for an NLE auto-editing plugin ($19.80/mo for its AI plan, Premiere Pro and Resolve only) but has zero Indic language support and is Windows/macOS plugin-only — no standalone web or desktop app, no captions styling of the depth a captions-first product needs.",
    facts: [
      {
        label: "Indic / Hinglish support",
        them: "None.",
        us: "Hindi, 21 other Indian languages and 90+ global languages, routed per language.",
      },
      {
        label: "Surfaces",
        them: "Premiere Pro and DaVinci Resolve plugins only; no web or desktop app.",
        us: "Web, desktop and Premiere Pro, After Effects and DaVinci Resolve plugins, one account and one credit pool.",
      },
      {
        label: "Caption styling",
        them: "Silence/filler cutting is the core; captions are not the focus.",
        us: "30+ named caption styles, every word tunable, saved templates and brand kits.",
      },
      {
        label: "Currency",
        them: "USD only ($9.90–$19.80/mo).",
        us: "₹ pricing by default with a USD toggle.",
      },
    ],
    weaknessesNoted: [
      "No Indic language support at all.",
      "Plugin-only — no standalone web or desktop editor.",
      "USD only.",
    ],
  },
];

export function comparisonBySlug(slug: string): ComparisonPage | undefined {
  return COMPARISON_PAGES.find((entry) => entry.slug === slug);
}
