/**
 * The export decision engine (D04, D26, D34; `04-pricing-and-monetization.md`
 * §Plans, §Offers).
 *
 * Pure and synchronous on purpose: every input is a value the caller already
 * resolved (the workspace's entitlement, the signup gift and ₹9-pass balance, the
 * request's capability probe), so the ≥25 table tests can assert the whole
 * matrix without a database. `ExportsService` is the only caller and the only
 * place any of this touches Prisma.
 *
 * Two independent questions, decided together because both read the same
 * inputs, but never conflated:
 *
 * 1. **Path** — does this render happen in the browser or in the cloud? Decided
 *    by output kind, requested resolution/length against the browser's
 *    technical caps (D34), and the capability probe.
 * 2. **Watermark** — is the output watermarked? Decided by the plan's watermark
 *    rule and, for Free, whether the signup gift or the ₹9 pass clears it — and
 *    those only ever clear it on the browser path, ≤ 10 minutes (D04).
 *
 * `reasons[]` are the sentences `POST /projects/{id}/exports` echoes back
 * verbatim for the export dialog (`08 §Export dialog`): "In this browser — no
 * upload", "Cloud render — 0.5 credits/min", and so on.
 */

import { HttpStatus } from "@nestjs/common";

import { quote } from "@montaj/config";
import type { OutputKind, RenderPreset } from "@montaj/render-manifest";

import { EXPORT_ERROR_CODES } from "./exports.errors.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";

/** `04 §Plans` ladder. */
export type PlanTier = "free" | "starter" | "creator" | "studio" | "agency";

/** What the client's capability probe reported (D34, `07 POST /exports`). */
export interface ExportCapabilities {
  readonly codecs?: readonly string[];
  readonly audioEncoder?: boolean;
  readonly discardedTracks?: readonly string[];
  /** File System Access, needed for a 4K browser export to avoid buffering it all in memory. */
  readonly fileSink?: boolean;
  /** Desktop Chrome or Edge; the only browsers 4K in-browser is offered on. */
  readonly isDesktopChromium?: boolean;
  /** A phone or tablet browser; always cloud regardless of everything else. */
  readonly isMobile?: boolean;
  readonly throughputMbps?: number;
}

export type SubtitleFormat = "srt" | "vtt" | "txt" | "md" | "ass";

export interface ExportDecisionInput {
  readonly requestedMode: "auto" | "browser" | "cloud";
  readonly kind: "video" | "subtitle";
  /** Video only; ignored (and irrelevant) for a subtitle request. */
  readonly outputKind?: OutputKind;
  readonly preset: RenderPreset;
  readonly customWidth?: number;
  readonly customHeight?: number;
  /** Subtitle formats requested; video requests ignore this. */
  readonly subtitleFormats?: readonly SubtitleFormat[];
  /** Length of the uploaded source, whole milliseconds. */
  readonly sourceDurationMs: number;
  /** Length of the render after accepted cuts (D30) — what the caps measure. */
  readonly outputDurationMs: number;
  readonly plan: PlanTier;
  /** `Plan.entitlements` (`prisma/seed-data.ts` shape). */
  readonly entitlements: Readonly<Record<string, unknown>>;
  /** Free workspace has not yet spent its one signup-gift export (D04). */
  readonly signupGiftAvailable: boolean;
  /** Free workspace holds an unconsumed ₹9 pass (B04 fills the real ledger). */
  readonly ninePassAvailable: boolean;
  readonly capabilities?: ExportCapabilities;
  /** HDR source; browser export tone-maps it and shows a notice (D34). Informational only. */
  readonly isHdrSource?: boolean;
  /**
   * Whether every `StyleDoc` the project's captions actually use carries
   * `assRenderable: true` — the flag only `@montaj/ass-exporter`'s parity gate
   * writes (D33). The caller (`ExportsService`) resolves the project's style
   * snapshot and reduces it to this one boolean so the decision stays pure
   * and synchronous; omitted (or `false`) refuses an `ass` subtitle request,
   * exactly as it did before A18a landed.
   */
  readonly assStylesRenderable?: boolean;
}

export type ExportPath = "browser" | "cloud";

/** Which entitlement, if any, cleared the watermark. */
export type WatermarkSource = "plan" | "signup_gift" | "nine_pass" | "none";

export interface ExportDecision {
  readonly path: ExportPath;
  /** Human-readable, UI-safe sentences (`08 §Export dialog`). */
  readonly reasons: readonly string[];
  readonly watermark: boolean;
  readonly watermarkSource: WatermarkSource;
  readonly consumesSignupGift: boolean;
  readonly consumesNinePass: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxDurationMs: number;
  readonly maxFps: number;
  readonly allowAlpha: boolean;
  /** 0.5 credits per output minute; 0 for the browser path and for subtitles. */
  readonly creditEstimateTenths: number;
}

const BROWSER_1080P_MAX_MS = 20 * 60_000;
const BROWSER_4K_MAX_MS = 10 * 60_000;
const SIGNUP_GIFT_MAX_MS = 10 * 60_000;
const NINE_PASS_MAX_MS = 10 * 60_000;

const FOUR_K_WIDTH = 2_560;
const DEFAULT_MAX_FPS_BROWSER = 60;
const DEFAULT_MAX_FPS_CLOUD = 60;

/** `entitlements.maxExportResolution` values (`prisma/seed-data.ts`). */
type MaxResolution = "1080p" | "4k";

function planMaxResolution(entitlements: Readonly<Record<string, unknown>>): MaxResolution {
  return entitlements["maxExportResolution"] === "4k" ? "4k" : "1080p";
}

function planWatermarkRule(entitlements: Readonly<Record<string, unknown>>): "none" | "gated" {
  return entitlements["watermark"] === "none" ? "none" : "gated";
}

/** The pixel width the request targets, from a named preset or a custom size. */
function requestedWidth(input: ExportDecisionInput): number {
  if (input.preset === "youtube-4k") return 3_840;
  if (input.preset === "custom") return Math.max(1, input.customWidth ?? 1_080);
  return 1_080; // reels, shorts, square
}

function isFourK(width: number): boolean {
  return width >= FOUR_K_WIDTH;
}

/**
 * B02b: routed through `@montaj/config`'s `quote()` rather than a local
 * `CLOUD_RENDER_TENTHS_PER_MINUTE` constant and hand-rolled whole-minute
 * rounding — both drift risks against `BURN_RATES.cloudRender`, which bills
 * on the 0.1-minute billing quantum (`BILLING_QUANTUM_MS`), not a whole one.
 */
function creditsFor(outputDurationMs: number): number {
  return quote("cloudRender", outputDurationMs / 60_000).costTenths;
}

/**
 * Whether the browser path is technically eligible at all (D34), independent of
 * plan and watermark. Returns the reason it is not, when it is not.
 */
function browserEligibility(
  input: ExportDecisionInput,
): { ok: true } | { ok: false; reason: string } {
  const capabilities = input.capabilities;

  if (input.outputKind === "alpha" || input.outputKind === "greenscreen") {
    return {
      ok: false,
      reason:
        "Alpha and green-screen exports render in the cloud — no shipping browser keeps an alpha " +
        "channel through hardware encode.",
    };
  }
  if (capabilities?.isMobile === true) {
    return { ok: false, reason: "Mobile browsers render in the cloud." };
  }

  const width = requestedWidth(input);
  if (isFourK(width)) {
    const eligible =
      capabilities?.isDesktopChromium === true &&
      capabilities.fileSink === true &&
      input.outputDurationMs <= BROWSER_4K_MAX_MS;
    if (!eligible) {
      return {
        ok: false,
        reason:
          "4K export needs Chrome or Edge on desktop, and 10 minutes or less — this renders in the cloud.",
      };
    }
    return { ok: true };
  }

  if (input.outputDurationMs > BROWSER_1080P_MAX_MS) {
    return {
      ok: false,
      reason: "Longer than 20 minutes — this renders in the cloud.",
    };
  }
  return { ok: true };
}

/** Video-only: choose the render path, honouring an explicit `mode`. */
function choosePath(input: ExportDecisionInput): { path: ExportPath; reasons: string[] } {
  const eligibility = browserEligibility(input);

  if (input.requestedMode === "cloud") {
    return { path: "cloud", reasons: ["Cloud render requested."] };
  }
  if (input.requestedMode === "browser") {
    if (!eligibility.ok) {
      throw new AppException(
        ERROR_CODES.exportUnsupportedInBrowser,
        eligibility.reason,
        HttpStatus.CONFLICT,
        { reason: eligibility.reason },
      );
    }
    return { path: "browser", reasons: ["In this browser — no upload."] };
  }
  // auto
  if (eligibility.ok) return { path: "browser", reasons: ["In this browser — no upload."] };
  return {
    path: "cloud",
    reasons: [eligibility.reason, "Cloud render — 0.5 credits per output minute."],
  };
}

/** The watermark decision, independent of path except that the gift/pass need `browser`. */
function chooseWatermark(
  input: ExportDecisionInput,
  path: ExportPath,
): {
  watermark: boolean;
  watermarkSource: WatermarkSource;
  consumesSignupGift: boolean;
  consumesNinePass: boolean;
  reason: string;
} {
  if (planWatermarkRule(input.entitlements) === "none") {
    return {
      watermark: false,
      watermarkSource: "plan",
      consumesSignupGift: false,
      consumesNinePass: false,
      reason: "Your plan exports without a watermark.",
    };
  }

  const cleanEligible = path === "browser" && input.sourceDurationMs <= SIGNUP_GIFT_MAX_MS;

  if (cleanEligible && input.signupGiftAvailable) {
    return {
      watermark: false,
      watermarkSource: "signup_gift",
      consumesSignupGift: true,
      consumesNinePass: false,
      reason: "Your free clean export.",
    };
  }
  if (cleanEligible && input.ninePassAvailable && input.sourceDurationMs <= NINE_PASS_MAX_MS) {
    return {
      watermark: false,
      watermarkSource: "nine_pass",
      consumesSignupGift: false,
      consumesNinePass: true,
      reason: "₹9 clean export.",
    };
  }
  return {
    watermark: true,
    watermarkSource: "none",
    consumesSignupGift: false,
    consumesNinePass: false,
    reason: "Free plan exports carry a watermark. Upgrade or buy a clean export to remove it.",
  };
}

/** Caps to embed in the signed manifest (`@montaj/render-manifest` `RenderCaps`). */
function capsFor(
  input: ExportDecisionInput,
  path: ExportPath,
): {
  maxWidth: number;
  maxHeight: number;
  maxDurationMs: number;
  maxFps: number;
  allowAlpha: boolean;
} {
  const maxRes = planMaxResolution(input.entitlements);
  const maxWidth = maxRes === "4k" ? 3_840 : 1_920;
  const maxHeight = maxWidth; // both aspects share the long edge as the cap (square, 9:16, 16:9, 4:5)

  if (path === "browser") {
    const width = requestedWidth(input);
    const maxDurationMs = isFourK(width) ? BROWSER_4K_MAX_MS : BROWSER_1080P_MAX_MS;
    return {
      maxWidth,
      maxHeight,
      maxDurationMs,
      maxFps: DEFAULT_MAX_FPS_BROWSER,
      allowAlpha: false,
    };
  }

  const planDurationMs =
    typeof input.entitlements["maxDurationMs"] === "number" &&
    input.entitlements["maxDurationMs"] > 0
      ? (input.entitlements["maxDurationMs"] as number)
      : BROWSER_1080P_MAX_MS;
  const allowAlpha = input.outputKind === "alpha";
  return {
    maxWidth,
    maxHeight,
    maxDurationMs: Math.max(planDurationMs, input.outputDurationMs),
    maxFps: DEFAULT_MAX_FPS_CLOUD,
    allowAlpha,
  };
}

/** Refuse a resolution the plan does not carry at all, before path/watermark are even asked. */
function assertResolutionEntitled(input: ExportDecisionInput): void {
  const width = requestedWidth(input);
  if (!isFourK(width)) return;
  if (planMaxResolution(input.entitlements) === "4k") return;
  throw new AppException(
    ERROR_CODES.entitlementUpgradeRequired,
    "4K export needs Creator or above.",
    HttpStatus.PAYMENT_REQUIRED,
    { requiredPlan: "creator", requested: "4k" },
  );
}

/** Refuse a subtitle format the plan or the product does not offer yet. */
function assertSubtitleFormatsAllowed(input: ExportDecisionInput): void {
  const formats = input.subtitleFormats ?? [];
  const available = new Set(
    Array.isArray(input.entitlements["subtitleFormats"])
      ? (input.entitlements["subtitleFormats"] as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : ["srt", "vtt", "txt"],
  );
  for (const format of formats) {
    // ASS is refused unless every style the project's captions use has
    // passed A18a's parity gate (`assRenderable: true`, D33); DOCX is not
    // generated anywhere yet (orchestrator addendum, after A20). Both are
    // refused here rather than enqueued to fail deep inside the render worker.
    if (format === "ass" && input.assStylesRenderable !== true) {
      throw new AppException(
        EXPORT_ERROR_CODES.formatUnavailable,
        "ASS subtitle export is not available yet.",
        HttpStatus.CONFLICT,
        { format },
      );
    }
    if (!available.has(format)) {
      throw new AppException(
        EXPORT_ERROR_CODES.formatUpgradeRequired,
        `The ${format.toUpperCase()} subtitle format needs a higher plan.`,
        HttpStatus.PAYMENT_REQUIRED,
        { format, requiredPlan: "creator" },
      );
    }
  }
}

/**
 * Decide the export. Throws `AppException` for a hard entitlement or format
 * refusal; otherwise returns the full decision, including every reason string.
 */
export function decideExport(input: ExportDecisionInput): ExportDecision {
  if (input.kind === "subtitle") {
    assertSubtitleFormatsAllowed(input);
    const reasons =
      input.requestedMode === "browser"
        ? ["Subtitles render on the server — there is no browser subtitle path."]
        : ["Subtitles render on the server, at no credit cost."];
    return {
      path: "cloud",
      reasons,
      watermark: false,
      watermarkSource: "none",
      consumesSignupGift: false,
      consumesNinePass: false,
      ...capsFor(input, "cloud"),
      creditEstimateTenths: 0,
    };
  }

  assertResolutionEntitled(input);
  const { path, reasons } = choosePath(input);
  const watermarkDecision = chooseWatermark(input, path);
  const caps = capsFor(input, path);

  return {
    path,
    reasons: [...reasons, watermarkDecision.reason],
    watermark: watermarkDecision.watermark,
    watermarkSource: watermarkDecision.watermarkSource,
    consumesSignupGift: watermarkDecision.consumesSignupGift,
    consumesNinePass: watermarkDecision.consumesNinePass,
    ...caps,
    creditEstimateTenths: path === "cloud" ? creditsFor(input.outputDurationMs) : 0,
  };
}
