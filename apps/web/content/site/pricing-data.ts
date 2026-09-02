/**
 * The plan catalogue the marketing site renders (04-pricing-and-monetization.md
 * §Plans, §Offers, §Streak rewards).
 *
 * **Provenance, not invention.** Every number below is transcribed from
 * `apps/api/prisma/seed-data.ts` (`PLAN_SEEDS`, the table the API seeds into
 * Postgres — CONTRACTS §0 money shape: integer minor units, ISO currency) and
 * cross-checked against `03-architecture/04-pricing-and-monetization.md §Plans`.
 * Nothing here is a marketing-page guess.
 *
 * **Why this is a static file and not a live fetch.** `07-api-and-contracts.md`
 * §Billing documents a public `GET /billing/plans`, but no billing module exists
 * in `apps/api/src` yet (Billing is Wave 2, work packages B01–B03; only Wave 1
 * work packages — the `A*` ones — have shipped). A24's file boundary is
 * `apps/web/app/(site)/**`, `apps/web/content/site/**`, `apps/web/public/**` and
 * `CHANGELOG.md`: it does not extend to `apps/api` or `packages/api-client`, so
 * this WP cannot stand up the endpoint the brief assumes. `getPlanCatalogue()`
 * below is the seam: it is the only function the pricing page calls, its
 * signature already matches what a `@montaj/api-client` `getPlans()` would
 * return, and swapping the body for a fetch is a one-function change that
 * touches no page component. Reported as a deviation in the WP's final report.
 */

export type Currency = "INR" | "USD";
export type PlanKey = "free" | "starter" | "creator" | "studio" | "agency";

export interface PlanPrice {
  /** Minor units (paise / cents), inclusive of 18% GST for INR. */
  readonly month: number;
  readonly year: number;
  /** Studio only — the ₹15,000 UPI-mandate-cap workaround (04 §Offers). */
  readonly halfyear?: number;
}

export interface PlanCatalogueEntry {
  readonly key: PlanKey;
  readonly name: string;
  readonly tagline: string;
  readonly mostPopular: boolean;
  readonly prices: Record<Currency, PlanPrice>;
  /** Agency and Studio sell extra seats; `null` for plans without seats. */
  readonly seatPrice: Record<Currency, number> | null;
  readonly creditsPerMonth: number;
  /** The handful of lines a plan card leads with. */
  readonly highlights: readonly string[];
  readonly ctaLabel: string;
}

/** Plans in ladder order — index doubles as the tier comparison (seed-data.ts). */
export const PLAN_CATALOGUE: readonly PlanCatalogueEntry[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Try the whole product on one project.",
    mostPopular: false,
    prices: {
      INR: { month: 0, year: 0 },
      USD: { month: 0, year: 0 },
    },
    seatPrice: null,
    creditsPerMonth: 20,
    highlights: [
      "20 credits a month",
      "One watermark-free 1080p browser export on signup",
      "All 30+ styles, Google Fonts",
      "Plugin preview + 3 watermark-free renders to try",
    ],
    ctaLabel: "Start free",
  },
  {
    key: "starter",
    name: "Starter",
    tagline: "Watermark-free, for a channel posting occasionally.",
    mostPopular: false,
    prices: {
      INR: { month: 29_900, year: 298_800 },
      USD: { month: 800, year: 8_040 },
    },
    seatPrice: null,
    creditsPerMonth: 150,
    highlights: [
      "150 credits a month",
      "No watermark, 1080p exports",
      "English translation, local desktop mode",
      "Plugin burn-in & SRT",
    ],
    ctaLabel: "Get Starter",
  },
  {
    key: "creator",
    name: "Creator",
    tagline: "Editing passes, 4K and every plugin, full access.",
    mostPopular: true,
    prices: {
      INR: { month: 69_900, year: 698_400 },
      USD: { month: 1_900, year: 18_960 },
    },
    seatPrice: null,
    creditsPerMonth: 500,
    highlights: [
      "500 credits a month",
      "4K exports, all languages translated",
      "Autocut and Reframe & Zoom passes, audio clean",
      "Chapters, hook and full plugin access",
    ],
    ctaLabel: "Get Creator",
  },
  {
    key: "studio",
    name: "Studio",
    tagline: "The Pro engine, SFX/music and a team of three.",
    mostPopular: false,
    prices: {
      INR: { month: 199_900, year: 1_999_200, halfyear: 999_600 },
      USD: { month: 4_900, year: 49_200 },
    },
    seatPrice: { INR: 39_900, USD: 700 },
    creditsPerMonth: 1_800,
    highlights: [
      "1,800 credits a month",
      "Pro engine, SFX/Music, Text FX, Prompted edit",
      "3 seats included, client folders",
      "API access, highest queue priority",
    ],
    ctaLabel: "Get Studio",
  },
  {
    key: "agency",
    name: "Agency",
    tagline: "Per seat, for editors running client work.",
    mostPopular: false,
    prices: {
      INR: { month: 119_900, year: 1_198_800 },
      USD: { month: 2_900, year: 28_800 },
    },
    seatPrice: { INR: 119_900, USD: 2_900 },
    creditsPerMonth: 900,
    highlights: [
      "900 pooled credits per seat",
      "Client tags, per-client share links, GSTIN invoices",
      "3 active devices per seat",
      "API access, highest queue priority",
    ],
    ctaLabel: "Get Agency",
  },
];

export function planByKey(key: PlanKey): PlanCatalogueEntry {
  const plan = PLAN_CATALOGUE.find((entry) => entry.key === key);
  if (plan === undefined) throw new Error(`unknown plan key: ${key}`);
  return plan;
}

/** Minor units to a display string, e.g. 69_900 → "699", 1_900 → "19". */
export function minorToUnit(minorUnits: number): number {
  return Math.round(minorUnits) / 100;
}

const CURRENCY_FORMAT: Record<Currency, { locale: string; symbol: string }> = {
  INR: { locale: "en-IN", symbol: "₹" },
  USD: { locale: "en-US", symbol: "$" },
};

/** `formatPrice(69_900, "INR")` → "₹699"; whole rupees/dollars, no decimals shown when exact. */
export function formatPrice(minorUnits: number, currency: Currency): string {
  const value = minorToUnit(minorUnits);
  const { locale, symbol } = CURRENCY_FORMAT[currency];
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${symbol}${formatted}`;
}

/**
 * The full feature matrix, row by row, transcribed verbatim from 04 §Plans —
 * a feature-by-plan comparison table is how the source document itself presents
 * this, and the shape here mirrors it exactly so nothing is re-derived or
 * summarised into something the source doc does not say.
 */
export interface PlanMatrixRow {
  readonly label: string;
  readonly values: Record<PlanKey, string>;
}

export const PLAN_MATRIX: readonly PlanMatrixRow[] = [
  {
    label: "Watermark on burn-in",
    values: {
      free: "After the first clean export",
      starter: "No",
      creator: "No",
      studio: "No",
      agency: "No",
    },
  },
  {
    label: "Max export resolution",
    values: {
      free: "1080p (browser)",
      starter: "1080p",
      creator: "4K",
      studio: "4K",
      agency: "4K",
    },
  },
  {
    label: "Max file",
    values: {
      free: "500 MB · 20 min",
      starter: "2 GB · 60 min",
      creator: "4 GB · 3 h",
      studio: "8 GB · 6 h",
      agency: "8 GB · 6 h",
    },
  },
  {
    label: "Subtitle exports",
    values: {
      free: "SRT / VTT / TXT",
      starter: "+ ASS",
      creator: "+ DOCX / MD",
      studio: "+ DOCX / MD",
      agency: "+ DOCX / MD",
    },
  },
  {
    label: "Styles & templates",
    values: {
      free: "All 30+, Google Fonts",
      starter: "+ 5 custom fonts",
      creator: "+ 15 custom fonts, brand kit",
      studio: "+ 50 custom fonts, 3 brand kits",
      agency: "+ 50 custom fonts, client brand kits",
    },
  },
  {
    label: "Translation",
    values: {
      free: "—",
      starter: "English",
      creator: "All languages",
      studio: "All languages",
      agency: "All languages",
    },
  },
  {
    label: "Audio clean",
    values: { free: "—", starter: "—", creator: "Yes", studio: "Yes", agency: "Yes" },
  },
  {
    label: "Edit passes",
    values: {
      free: "—",
      starter: "—",
      creator: "Autocut, Reframe/Zoom (Flash)",
      studio: "+ Pro engine, SFX/Music, Text FX, Prompted",
      agency: "+ Pro engine, SFX/Music, Text FX, Prompted",
    },
  },
  {
    label: "Chapters / hook",
    values: { free: "—", starter: "—", creator: "Yes", studio: "Yes", agency: "Yes" },
  },
  {
    label: "Plugins (Premiere, After Effects, Resolve)",
    values: {
      free: "Preview + 3 watermark-free renders to try",
      starter: "Burn-in & SRT",
      creator: "Full",
      studio: "Full",
      agency: "Full",
    },
  },
  {
    label: "Local mode (desktop)",
    values: { free: "—", starter: "Yes", creator: "Yes", studio: "Yes", agency: "Yes" },
  },
  {
    label: "Active devices",
    values: { free: "1", starter: "1", creator: "2", studio: "5", agency: "3 per seat" },
  },
  {
    label: "Team seats",
    values: {
      free: "—",
      starter: "—",
      creator: "—",
      studio: "3 included, +₹399 / $7 per seat",
      agency: "Per seat",
    },
  },
  {
    label: "Client separation",
    values: {
      free: "—",
      starter: "—",
      creator: "—",
      studio: "Folders",
      agency: "Client tags, per-client share links, GSTIN invoices",
    },
  },
  {
    label: "Project retention",
    values: {
      free: "7 days",
      starter: "30 days",
      creator: "90 days",
      studio: "365 days",
      agency: "365 days",
    },
  },
  {
    label: "Queue priority",
    values: {
      free: "Standard",
      starter: "Standard",
      creator: "High",
      studio: "Highest",
      agency: "Highest",
    },
  },
  {
    label: "API access",
    values: { free: "—", starter: "—", creator: "—", studio: "Yes", agency: "Yes" },
  },
];

/** The offers ladder (04 §Offers, passes, top-ups). */
export interface Offer {
  readonly key: string;
  readonly title: string;
  readonly priceInr: string;
  readonly priceUsd: string;
  readonly description: string;
}

export const OFFERS: readonly Offer[] = [
  {
    key: "signup-gift",
    title: "Signup gift",
    priceInr: "Free",
    priceUsd: "Free",
    description:
      "One watermark-free 1080p browser-native export of a project up to 10 minutes, the moment you sign up.",
  },
  {
    key: "clean-export",
    title: "Clean export",
    priceInr: "₹9",
    priceUsd: "INR only",
    description:
      "Browser-native render only, project ≤ 10 min: one more watermark-free export without a plan. UPI or card.",
  },
  {
    key: "week-pass",
    title: "Week Pass",
    priceInr: "₹59",
    priceUsd: "$1.50",
    description: "7 days of Starter with 40 credits. One-time payment, no mandate.",
  },
  {
    key: "top-up",
    title: "Top-up (100 credits)",
    priceInr: "₹149",
    priceUsd: "$3",
    description:
      "Available on Free. Larger top-ups (₹899 / $17 for 500, ₹2,999 / $59 for 2,000) unlock on Starter+.",
  },
];

/**
 * Credits-to-outcomes (04 §Design goals point 4). The one worked example — "500
 * credits ≈ 8 h transcription ≈ 60 Reels ≈ 12 podcast episodes" — is quoted
 * verbatim from the source doc; the Starter and Studio rows scale the same three
 * ratios linearly rather than inventing independent numbers, and are labelled
 * "about" for exactly that reason.
 */
export interface OutcomeRow {
  readonly credits: number;
  readonly plan: string;
  readonly transcriptionHours: string;
  readonly reels: string;
  readonly podcastEpisodes: string;
  readonly sourced: boolean;
}

export const CREDITS_TO_OUTCOMES: readonly OutcomeRow[] = [
  {
    credits: 150,
    plan: "Starter",
    transcriptionHours: "about 2.5 h",
    reels: "about 18",
    podcastEpisodes: "about 4",
    sourced: false,
  },
  {
    credits: 500,
    plan: "Creator",
    transcriptionHours: "8 h",
    reels: "60",
    podcastEpisodes: "12",
    sourced: true,
  },
  {
    credits: 1_800,
    plan: "Studio",
    transcriptionHours: "about 30 h",
    reels: "about 216",
    podcastEpisodes: "about 43",
    sourced: false,
  },
];
