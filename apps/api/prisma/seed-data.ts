/**
 * Seed data: plans, feature flags and the system caption styles.
 *
 * Kept beside `seed.ts` rather than inside it so the constants can be read (and
 * asserted) without running a database transaction. Nothing here invents a price,
 * a credit allowance or a burn rate: prices come from `04-pricing-and-monetization
 * .md §Plans`, and everything credit-related is derived from `@montaj/config`, the
 * single source of truth named in CONTRACTS §4.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  BURN_RATES,
  CREDIT_OPERATIONS,
  TENTHS_PER_CREDIT,
  type CreditOperation,
  type PlanTier,
} from "@montaj/config";

import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID that is stable across runs, derived from a name.
 *
 * The seed has to be idempotent (acceptance criterion 1), and most rows are found
 * by a natural key — but a few (the demo workspace's credit lot and its ledger
 * row) have none. Hashing their name into the ULID's random field gives them a
 * fixed id, so a second run updates the same row instead of inserting a twin.
 * The timestamp field is a fixed epoch for the same reason.
 */
export function seedUlid(name: string): string {
  const SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

  let time = SEED_EPOCH_MS;
  let timePart = "";
  for (let i = 0; i < 10; i += 1) {
    timePart = `${CROCKFORD[time % 32] ?? "0"}${timePart}`;
    time = Math.floor(time / 32);
  }

  const digest = createHash("sha256").update(`montaj-seed:${name}`).digest();
  let randomPart = "";
  let bits = 0;
  let acc = 0;
  for (let i = 0; randomPart.length < 16; i += 1) {
    acc = (acc << 8) | (digest[i % digest.length] ?? 0);
    bits += 8;
    while (bits >= 5 && randomPart.length < 16) {
      bits -= 5;
      randomPart += CROCKFORD[(acc >> bits) & 31] ?? "0";
    }
  }

  return timePart + randomPart;
}

// ---------------------------------------------------------------------------
// Plans (04 §Plans)
// ---------------------------------------------------------------------------

/** Plans in ladder order; index doubles as the tier comparison for entitlements. */
export const PLAN_LADDER = ["free", "starter", "creator", "studio", "agency"] as const;
export type PlanKeyName = (typeof PLAN_LADDER)[number];

/** True when `plan` is at least as high on the ladder as `minimum`. */
export function planMeets(plan: PlanKeyName, minimum: PlanTier | null): boolean {
  if (minimum === null) return true;
  return PLAN_LADDER.indexOf(plan) >= PLAN_LADDER.indexOf(minimum as PlanKeyName);
}

/**
 * Which credit-consuming operations a plan may run, derived from the `minimumPlan`
 * column of the burn-rate table in `@montaj/config`. Deriving it means a change to
 * a burn rate's gating cannot drift from the seeded entitlements.
 */
export function operationsFor(plan: PlanKeyName): Record<CreditOperation, boolean> {
  const entries = CREDIT_OPERATIONS.map((operation) => [
    operation,
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    planMeets(plan, BURN_RATES[operation].minimumPlan),
  ]);
  return Object.fromEntries(entries) as Record<CreditOperation, boolean>;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export interface PlanSeed {
  readonly key: PlanKeyName;
  readonly name: string;
  /** Minor units (paise / cents), inclusive of 18% GST for INR (04 §Tax). */
  readonly prices: Prisma.InputJsonValue;
  /** Monthly grant in TENTHS of a credit (CONTRACTS §0). */
  readonly creditsPerMonthTenths: number;
  readonly seatPrice: Prisma.InputJsonValue | null;
  readonly entitlements: Prisma.InputJsonValue;
}

/** Credits per month as printed in 04 §Plans, converted to tenths. */
const CREDITS_PER_MONTH: Record<PlanKeyName, number> = {
  free: 20,
  starter: 150,
  creator: 500,
  studio: 1_800,
  agency: 900,
};

export const PLAN_SEEDS: readonly PlanSeed[] = [
  {
    key: "free",
    name: "Free",
    prices: { INR: { month: 0, year: 0 }, USD: { month: 0, year: 0 } },
    creditsPerMonthTenths: CREDITS_PER_MONTH.free * TENTHS_PER_CREDIT,
    seatPrice: null,
    entitlements: {
      watermark: "after_first_clean_export",
      signupGift: { exports: 1, maxResolution: "1080p", maxDurationMs: 10 * MINUTE_MS },
      maxExportResolution: "1080p",
      browserRenderOnly: true,
      maxFileBytes: 500 * MB,
      maxDurationMs: 20 * MINUTE_MS,
      subtitleFormats: ["srt", "vtt", "txt"],
      customFonts: 0,
      brandKits: 0,
      translation: "none",
      audioClean: false,
      passes: {
        autocut: false,
        reframeZoom: false,
        sfxMusic: false,
        textFx: false,
        prompted: false,
        proEngine: false,
      },
      chaptersHook: false,
      plugins: "preview_3_clean_renders",
      localMode: false,
      activeDevices: 1,
      seatsIncluded: 0,
      extraSeatPrice: null,
      clientSeparation: "none",
      partnerAudioLibrary: false,
      retentionDays: 7,
      queuePriority: "standard",
      apiAccess: false,
      operations: operationsFor("free"),
    },
  },
  {
    key: "starter",
    name: "Starter",
    prices: { INR: { month: 29_900, year: 298_800 }, USD: { month: 800, year: 8_040 } },
    creditsPerMonthTenths: CREDITS_PER_MONTH.starter * TENTHS_PER_CREDIT,
    seatPrice: null,
    entitlements: {
      watermark: "none",
      signupGift: null,
      maxExportResolution: "1080p",
      browserRenderOnly: false,
      maxFileBytes: 2 * GB,
      maxDurationMs: 60 * MINUTE_MS,
      subtitleFormats: ["srt", "vtt", "txt", "ass"],
      customFonts: 5,
      brandKits: 0,
      translation: "english",
      audioClean: false,
      passes: {
        autocut: false,
        reframeZoom: false,
        sfxMusic: false,
        textFx: false,
        prompted: false,
        proEngine: false,
      },
      chaptersHook: false,
      plugins: "burnin_and_srt",
      localMode: true,
      activeDevices: 1,
      seatsIncluded: 0,
      extraSeatPrice: null,
      clientSeparation: "none",
      partnerAudioLibrary: false,
      retentionDays: 30,
      queuePriority: "standard",
      apiAccess: false,
      operations: operationsFor("starter"),
    },
  },
  {
    key: "creator",
    name: "Creator",
    prices: { INR: { month: 69_900, year: 698_400 }, USD: { month: 1_900, year: 18_960 } },
    creditsPerMonthTenths: CREDITS_PER_MONTH.creator * TENTHS_PER_CREDIT,
    seatPrice: null,
    entitlements: {
      watermark: "none",
      signupGift: null,
      maxExportResolution: "4k",
      browserRenderOnly: false,
      maxFileBytes: 4 * GB,
      maxDurationMs: 3 * HOUR_MS,
      subtitleFormats: ["srt", "vtt", "txt", "ass", "docx", "md"],
      customFonts: 15,
      brandKits: 1,
      translation: "all",
      audioClean: true,
      passes: {
        autocut: true,
        reframeZoom: true,
        sfxMusic: false,
        textFx: false,
        prompted: true,
        proEngine: false,
      },
      chaptersHook: true,
      plugins: "full",
      localMode: true,
      activeDevices: 2,
      seatsIncluded: 0,
      extraSeatPrice: null,
      clientSeparation: "none",
      partnerAudioLibrary: false,
      retentionDays: 90,
      queuePriority: "high",
      apiAccess: false,
      operations: operationsFor("creator"),
    },
  },
  {
    key: "studio",
    name: "Studio",
    prices: {
      INR: { month: 199_900, year: 1_999_200, halfyear: 999_600 },
      USD: { month: 4_900, year: 49_200 },
    },
    creditsPerMonthTenths: CREDITS_PER_MONTH.studio * TENTHS_PER_CREDIT,
    seatPrice: { INR: 39_900, USD: 700 },
    entitlements: {
      watermark: "none",
      signupGift: null,
      maxExportResolution: "4k",
      browserRenderOnly: false,
      maxFileBytes: 8 * GB,
      maxDurationMs: 6 * HOUR_MS,
      subtitleFormats: ["srt", "vtt", "txt", "ass", "docx", "md"],
      customFonts: 50,
      brandKits: 3,
      translation: "all",
      audioClean: true,
      passes: {
        autocut: true,
        reframeZoom: true,
        sfxMusic: true,
        textFx: true,
        prompted: true,
        proEngine: true,
      },
      chaptersHook: true,
      plugins: "full",
      localMode: true,
      activeDevices: 5,
      seatsIncluded: 3,
      extraSeatPrice: { INR: 39_900, USD: 700 },
      clientSeparation: "folders",
      partnerAudioLibrary: true,
      retentionDays: 365,
      queuePriority: "highest",
      apiAccess: true,
      operations: operationsFor("studio"),
    },
  },
  {
    key: "agency",
    name: "Agency",
    prices: { INR: { month: 119_900, year: 1_198_800 }, USD: { month: 2_900, year: 28_800 } },
    creditsPerMonthTenths: CREDITS_PER_MONTH.agency * TENTHS_PER_CREDIT,
    seatPrice: { INR: 119_900, USD: 2_900 },
    entitlements: {
      watermark: "none",
      signupGift: null,
      maxExportResolution: "4k",
      browserRenderOnly: false,
      maxFileBytes: 8 * GB,
      maxDurationMs: 6 * HOUR_MS,
      subtitleFormats: ["srt", "vtt", "txt", "ass", "docx", "md"],
      customFonts: 50,
      brandKits: "per_client",
      translation: "all",
      audioClean: true,
      passes: {
        autocut: true,
        reframeZoom: true,
        sfxMusic: true,
        textFx: true,
        prompted: true,
        proEngine: true,
      },
      chaptersHook: true,
      plugins: "full",
      localMode: true,
      /// Per seat, not per workspace (04 §Plans).
      activeDevices: 3,
      perSeat: true,
      seatsIncluded: 1,
      extraSeatPrice: { INR: 119_900, USD: 2_900 },
      clientSeparation: "client_tags",
      partnerAudioLibrary: true,
      retentionDays: 365,
      queuePriority: "highest",
      apiAccess: true,
      operations: operationsFor("agency"),
    },
  },
];

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export interface FeatureFlagSeed {
  readonly key: string;
  readonly description: string;
}

/** All off by default: each one gates work that is not built or not cleared yet. */
export const FEATURE_FLAG_SEEDS: readonly FeatureFlagSeed[] = [
  {
    key: "repurpose_flow",
    description:
      "Guided five-stage repurposing workflow. Off until the sequential repurposing checkpoints pass.",
  },
  {
    key: "source_youtube_acquire",
    description:
      "Authorized YouTube source acquisition. Off until the downloader, limits, rights, and security gates pass.",
  },
  {
    key: "highlight_discovery",
    description:
      "Multimodal highlight candidate discovery. Off until schema parity and multilingual quality benchmarks pass.",
  },
  {
    key: "publishing_postiz",
    description:
      "Postiz-backed account connection and publishing. Off until staging, token-boundary, and reconciliation gates pass.",
  },
  {
    key: "publishing_tiktok",
    description:
      "TikTok publishing provider path. Off until provider review, scopes, consent, and test-account evidence pass.",
  },
  {
    key: "streak_experiment",
    description:
      "Streak levels, freezes and renewal discounts (04 §Streak rewards). Runs against a holdout; design pending RR-10.",
  },
  {
    key: "local_mode",
    description:
      "Desktop local transcription and render through the bundled engine (Starter+). Off until C03a ships a signed sidecar.",
  },
  {
    key: "partner_audio",
    description:
      "Partner music and SFX catalogues (Epidemic, Soundstripe, Storyblocks). Off until the contracts in A00-11 are signed (D04b).",
  },
  {
    key: "provider_bhashini",
    description:
      "Route Indic ASR to Bhashini. Off until the enquiry in A00-06 and an eval on the A00-05 sets both pass.",
  },
];

// ---------------------------------------------------------------------------
// System caption styles
// ---------------------------------------------------------------------------

/** One style's row in `packages/caption-styles/parity/results.json` (A18a, D33). */
export interface StyleParitySeed {
  readonly assRenderable: boolean;
  readonly assExportable: boolean;
  readonly requiresLayoutMetrics: boolean;
  readonly parityScore?: number;
}

export interface StyleSeed {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly minPlan: PlanKeyName;
  readonly doc: Prisma.InputJsonValue;
  /** Present only when `parity/results.json` has a measured row for this style. */
  readonly parity?: StyleParitySeed;
}

/**
 * Pulls the parity fields off an already-loaded style document. `doc` is the
 * `StyleDoc` JSON itself — `assRenderable`/`assExportable`/
 * `requiresLayoutMetrics`/`parityScore` are fields *on it* (schema.ts),
 * written only by `pnpm --filter @montaj/ass-exporter parity`'s
 * `apply-flags.ts`, never by hand (D33). A checkout where the gate has never
 * run has every style at the schema's own pre-gate defaults (`false`/
 * `false`/`true`/`undefined`), which round-trips through here unchanged.
 */
export function parityOf(doc: Record<string, unknown>): StyleParitySeed | undefined {
  if (typeof doc["assRenderable"] !== "boolean" || typeof doc["assExportable"] !== "boolean") {
    return undefined;
  }
  return {
    assRenderable: doc["assRenderable"],
    assExportable: doc["assExportable"],
    requiresLayoutMetrics: doc["requiresLayoutMetrics"] === true,
    ...(typeof doc["parityScore"] === "number" ? { parityScore: doc["parityScore"] } : {}),
  };
}

/** Where the fixtures came from, so the seed can say so out loud. */
export type StyleSource = "package" | "fixtures" | "fallback";

export interface LoadedStyles {
  readonly source: StyleSource;
  readonly styles: readonly StyleSeed[];
}

/**
 * A minimal but complete StyleDoc v2, in the shape 03 §F-305 describes: typography,
 * colours, box, stroke, shadow, animation (in/out/highlight), position and per-word
 * rules. These are placeholders with the right structure, not the finished looks —
 * A16 writes the real 30+ styles and A18a writes the parity flags.
 */
function fallbackDoc(overrides: Record<string, unknown>): Prisma.InputJsonValue {
  return {
    schemaVersion: 2,
    typography: {
      fontFamily: "Inter",
      fontWeight: 800,
      fontSizePx: 72,
      lineHeight: 1.1,
      letterSpacing: 0,
      uppercase: false,
      maxCharsPerLine: 22,
      maxLines: 2,
    },
    colours: { fill: "#FFFFFF", highlight: "#FFD400", background: null },
    box: { enabled: false, padding: 16, radius: 12, colour: "#000000CC" },
    stroke: { enabled: true, widthPx: 6, colour: "#000000" },
    shadow: { enabled: true, offsetX: 0, offsetY: 4, blur: 12, colour: "#00000099" },
    animation: { in: "fade", out: "fade", highlight: "none", durationMs: 120 },
    position: { anchor: "bottom-center", x: 0.5, y: 0.82, safeAreaPct: 0.06 },
    perWord: { mode: "line", activeScale: 1.0, inactiveOpacity: 1.0 },
    ...overrides,
  } as Prisma.InputJsonValue;
}

/**
 * The five system styles seeded when `@montaj/caption-styles` has no fixtures yet.
 * Names describe the look — never a person, creator or brand (F-305 naming rule).
 */
const FALLBACK_STYLES: readonly StyleSeed[] = [
  {
    key: "punch-pop",
    name: "Punch Pop",
    category: "energetic",
    minPlan: "free",
    doc: fallbackDoc({
      perWord: { mode: "word", activeScale: 1.12, inactiveOpacity: 0.55 },
      animation: { in: "pop", out: "fade", highlight: "scale", durationMs: 90 },
    }),
  },
  {
    key: "hype-bold",
    name: "Hype Bold",
    category: "energetic",
    minPlan: "free",
    doc: fallbackDoc({
      typography: {
        fontFamily: "Inter",
        fontWeight: 900,
        fontSizePx: 84,
        lineHeight: 1.05,
        letterSpacing: -1,
        uppercase: true,
        maxCharsPerLine: 18,
        maxLines: 2,
      },
      colours: { fill: "#FFFFFF", highlight: "#00E5FF", background: null },
    }),
  },
  {
    key: "karaoke-fill",
    name: "Karaoke Fill",
    category: "karaoke",
    minPlan: "free",
    doc: fallbackDoc({
      perWord: { mode: "fill", activeScale: 1.0, inactiveOpacity: 0.4 },
      animation: { in: "none", out: "none", highlight: "fill", durationMs: 0 },
    }),
  },
  {
    key: "word-pop",
    name: "Word Pop",
    category: "energetic",
    minPlan: "free",
    doc: fallbackDoc({
      perWord: { mode: "word", activeScale: 1.2, inactiveOpacity: 0 },
      typography: {
        fontFamily: "Inter",
        fontWeight: 800,
        fontSizePx: 96,
        lineHeight: 1,
        letterSpacing: 0,
        uppercase: true,
        maxCharsPerLine: 12,
        maxLines: 1,
      },
    }),
  },
  {
    key: "minimal-lower-third",
    name: "Minimal Lower Third",
    category: "clean",
    minPlan: "free",
    doc: fallbackDoc({
      box: { enabled: true, padding: 20, radius: 8, colour: "#000000B3" },
      stroke: { enabled: false, widthPx: 0, colour: "#000000" },
      position: { anchor: "bottom-left", x: 0.08, y: 0.86, safeAreaPct: 0.06 },
      typography: {
        fontFamily: "Inter",
        fontWeight: 600,
        fontSizePx: 48,
        lineHeight: 1.25,
        letterSpacing: 0,
        uppercase: false,
        maxCharsPerLine: 34,
        maxLines: 2,
      },
    }),
  },
];

/** The slice of `@montaj/caption-styles` this seed uses. */
export interface CaptionStylesModule {
  loadSystemStyles?: () => readonly {
    key?: string;
    id?: string;
    name?: string;
    category?: string;
    minPlan?: string;
    doc?: unknown;
  }[];
}

/**
 * How {@link loadSystemStyles} reaches the package.
 *
 * Injected rather than hard-wired so the two degraded paths stay testable. They
 * are not hypothetical: the fixtures path is what a consumer that has the files
 * but not a built `dist/` falls back to, and the placeholder path is what runs
 * before A02-class work lands in a fresh checkout. A test that can only exercise
 * the happy path is not testing the fallback at all.
 */
export type StylesModuleLoader = () => CaptionStylesModule | undefined;

/** Production loader: the real package, or `undefined` when it cannot be resolved. */
export const requireCaptionStyles: StylesModuleLoader = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@montaj/caption-styles") as CaptionStylesModule;
  } catch {
    return undefined;
  }
};

/** A style file is a StyleDoc v2 when it declares an `id` and `version: 2`. */
function isStyleDocV2(raw: unknown): raw is Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  return typeof record["id"] === "string" && record["id"] !== "" && record["version"] === 2;
}

function normalise(raw: Record<string, unknown>, fallbackKey: string): StyleSeed | undefined {
  const key =
    typeof raw["key"] === "string"
      ? raw["key"]
      : typeof raw["id"] === "string"
        ? raw["id"]
        : fallbackKey;
  if (key === "") return undefined;
  const minPlan = PLAN_LADDER.find((candidate) => candidate === raw["minPlan"]) ?? "free";
  // A style file may be the StyleDoc itself or wrap it under `doc`.
  const docSource = (raw["doc"] ?? raw) as Record<string, unknown>;
  const parity = parityOf(docSource);
  return {
    key,
    name: typeof raw["name"] === "string" ? raw["name"] : key,
    category: typeof raw["category"] === "string" ? raw["category"] : "general",
    minPlan,
    doc: docSource as Prisma.InputJsonValue satisfies Prisma.InputJsonValue,
    ...(parity === undefined ? {} : { parity }),
  };
}

/**
 * System styles, from the best source available.
 *
 * Three tiers, tried in order:
 *   1. `@montaj/caption-styles`' own `loadSystemStyles()` — the real catalogue,
 *      schema-validated by the package including the D64 naming rule;
 *   2. the raw JSON in `packages/caption-styles/styles/` — for a checkout where
 *      the package exists but its `dist/` has not been built;
 *   3. the placeholders above.
 *
 * The chosen source is reported by the seed so nobody mistakes placeholders for
 * the real catalogue.
 */
export function loadSystemStyles(
  repoRoot = resolve(__dirname, "..", "..", ".."),
  loadStylesModule: StylesModuleLoader = requireCaptionStyles,
): LoadedStyles {
  const mod = loadStylesModule();
  if (typeof mod?.loadSystemStyles === "function") {
    const styles = mod
      .loadSystemStyles()
      .map((raw, index) => normalise(raw as Record<string, unknown>, `style-${index}`))
      .filter((style): style is StyleSeed => style !== undefined);
    if (styles.length > 0) return { source: "package", styles };
  }

  const fixtureDir = join(repoRoot, "packages", "caption-styles", "styles");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (existsSync(fixtureDir)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    const styles = readdirSync(fixtureDir)
      .filter((file) => file.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b, "en"))
      .map((file) => {
        let raw: unknown;
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
          raw = JSON.parse(readFileSync(join(fixtureDir, file), "utf8"));
        } catch {
          return undefined;
        }
        // `styles/` also holds `registry.json`, the catalogue index, which is not
        // a style. Rather than name that one file, accept only documents that
        // actually look like StyleDoc v2 — a roadmap file added later cannot then
        // silently become a style preset.
        if (!isStyleDocV2(raw)) return undefined;
        return normalise(raw, file.replace(/\.json$/, ""));
      })
      .filter((style): style is StyleSeed => style !== undefined);
    if (styles.length > 0) return { source: "fixtures", styles };
  }

  return { source: "fallback", styles: FALLBACK_STYLES };
}
