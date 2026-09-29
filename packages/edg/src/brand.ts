/**
 * How a workspace's brand kit becomes a document (2026-10-02).
 *
 * A brand kit is a workspace's colours, typefaces, logo placement and end card.
 * It is not part of the document: it is applied to one, as ordinary style
 * overrides and overlays, by Autopilot when it finishes a clip
 * (`apps/api/src/repurpose/clip-finishing.ts`) and by the editor when a person
 * puts a logo or an end card back. Both build them here, so they build the same
 * thing, and the settings page previews exactly what a clip will get.
 *
 * What each colour is for:
 *
 * - `primary` — the brand's accent: the hook title's card (unless the kit names
 *   one for it) and the handle on the end card;
 * - `secondary` — where a new end card's background starts;
 * - `text` — words on the brand's own surfaces (the hook card, the end card),
 *   used only where it reads against them; elsewhere black or white is chosen.
 *
 * A caption colour or typeface the kit leaves empty is the caption style's own,
 * so an empty kit changes nothing about the captions.
 */

import { z } from "zod";

import {
  END_CARD_CTA_MAX,
  END_CARD_HANDLE_MAX,
  HexColourSchema,
  LOGO_MARGIN_PCT,
  LOGO_SIZE_PCT,
  OverlayCornerSchema,
  type EndCardOverlay,
  type HookTitleAppearance,
  type LogoOverlay,
  type OverlayImage,
} from "./schemas/document.js";

/** The kit's stored shape generation (`brand_kits.doc.v`). */
export const BRAND_KIT_VERSION = 1;

/** How long an end card stays up, in ms: long enough to read, short enough to keep. */
export const END_CARD_DURATION_MS = { min: 2_000, max: 4_000, default: 3_000 } as const;

/** A typeface name; the API checks it against the bundled catalogue. */
const FontFamilySchema = z.string().trim().min(1).max(120);

export const BrandKitSettingsSchema = z
  .object({
    colors: z.object({
      primary: HexColourSchema,
      secondary: HexColourSchema,
      text: HexColourSchema,
    }),
    /** The captions' typeface and colours; an absent one is the caption style's own. */
    captions: z.object({
      fontFamily: FontFamilySchema.optional(),
      fill: HexColourSchema.optional(),
      highlight: HexColourSchema.optional(),
      stroke: HexColourSchema.optional(),
    }),
    /** The hook title's typeface and colours; the card falls back to `colors.primary`. */
    hookTitle: z.object({
      fontFamily: FontFamilySchema.optional(),
      background: HexColourSchema.optional(),
      text: HexColourSchema.optional(),
    }),
    /** Where the logo goes when there is one: `show` puts it in a corner of every clip. */
    logo: z.object({
      show: z.boolean(),
      corner: OverlayCornerSchema,
      sizePct: z.number().min(LOGO_SIZE_PCT.min).max(LOGO_SIZE_PCT.max),
      opacity: z.number().min(0.1).max(1),
      marginPct: z.number().min(LOGO_MARGIN_PCT.min).max(LOGO_MARGIN_PCT.max),
    }),
    /** The end card over a clip's last seconds; the clip keeps its length. */
    endCard: z.object({
      enabled: z.boolean(),
      cta: z.string().max(END_CARD_CTA_MAX),
      handle: z.string().max(END_CARD_HANDLE_MAX),
      background: HexColourSchema,
      showLogo: z.boolean(),
      durationMs: z.number().int().min(END_CARD_DURATION_MS.min).max(END_CARD_DURATION_MS.max),
    }),
  })
  .meta({ id: "BrandKitSettings", title: "BrandKitSettings" });

export type BrandKitSettings = z.infer<typeof BrandKitSettingsSchema>;

/** A kit nobody has touched: every caption setting the style's own, no end card. */
export const DEFAULT_BRAND_KIT_SETTINGS: BrandKitSettings = Object.freeze({
  colors: { primary: "#f0508a", secondary: "#141217", text: "#f1ece6" },
  captions: {},
  hookTitle: {},
  logo: { show: true, corner: "top-right", sizePct: 16, opacity: 0.9, marginPct: 4 },
  endCard: {
    enabled: false,
    cta: "",
    handle: "",
    background: "#141217",
    showLogo: true,
    durationMs: END_CARD_DURATION_MS.default,
  },
}) as BrandKitSettings;

/**
 * A stored kit (`brand_kits.doc`), or the defaults for anything missing or
 * malformed: a kit written by a later version is read field by field rather
 * than thrown away.
 */
export function brandKitSettingsOf(doc: unknown): BrandKitSettings {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return DEFAULT_BRAND_KIT_SETTINGS;
  }
  const record = doc as Record<string, unknown>;
  const merged = {
    colors: { ...DEFAULT_BRAND_KIT_SETTINGS.colors, ...objectOf(record["colors"]) },
    captions: objectOf(record["captions"]),
    hookTitle: objectOf(record["hookTitle"]),
    logo: { ...DEFAULT_BRAND_KIT_SETTINGS.logo, ...objectOf(record["logo"]) },
    endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, ...objectOf(record["endCard"]) },
  };
  const parsed = BrandKitSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_BRAND_KIT_SETTINGS;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** WCAG relative luminance of `#RRGGBB`. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio between two `#RRGGBB` colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Large, bold words read at 3:1 (WCAG AA for large text). */
const READABLE = 3;

/**
 * The document style overrides a kit's caption settings make: the typeface,
 * the resting colour, the highlight (the spoken word, and the keyword emphasis
 * Autopilot puts on one word a caption) and the outline colour. `undefined`
 * when the kit sets none of them. The caller merges it onto the document's own
 * overrides (`SetStyle` replaces them wholesale).
 *
 * @param emphasis the style's emphasis presets and the one keywords wear, so
 *   the highlight recolours that preset (an override replaces the whole list,
 *   so the list goes back as it was, one colour changed).
 */
export function brandCaptionOverrides(
  settings: BrandKitSettings,
  emphasis?: {
    readonly presets: readonly Readonly<Record<string, unknown>>[];
    readonly keywordPresetId?: string;
  },
): Record<string, unknown> | undefined {
  const { fontFamily, fill, highlight, stroke } = settings.captions;
  const overrides: Record<string, unknown> = {};
  if (fontFamily !== undefined) overrides["typography"] = { fontFamily };
  if (fill !== undefined || highlight !== undefined) {
    overrides["colors"] = {
      ...(fill === undefined ? {} : { text: fill }),
      ...(highlight === undefined ? {} : { activeText: highlight }),
    };
  }
  if (stroke !== undefined) overrides["stroke"] = { color: stroke };
  const keyword = emphasis?.keywordPresetId;
  if (
    highlight !== undefined &&
    emphasis !== undefined &&
    keyword !== undefined &&
    emphasis.presets.some((preset) => preset["id"] === keyword)
  ) {
    overrides["emphasisPresets"] = emphasis.presets.map((preset) =>
      preset["id"] === keyword ? { ...preset, color: highlight } : { ...preset },
    );
  }
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/**
 * The hook title's look under a kit: its typeface (else the captions'), its
 * card (else the brand's primary colour), and its words in the kit's colour
 * when that reads on the card (else render-core picks black or white).
 */
export function brandHookAppearance(settings: BrandKitSettings): HookTitleAppearance {
  const background = settings.hookTitle.background ?? settings.colors.primary;
  const text =
    settings.hookTitle.text ??
    (contrastRatio(settings.colors.text, background) >= READABLE
      ? settings.colors.text
      : undefined);
  const fontFamily = settings.hookTitle.fontFamily ?? settings.captions.fontFamily;
  return {
    ...(fontFamily === undefined ? {} : { fontFamily }),
    background,
    ...(text === undefined ? {} : { text }),
  };
}

/**
 * The logo in a corner for a clip, over `window` (its whole length), or
 * `undefined` when the kit has no logo or does not show it in a corner.
 */
export function brandLogoOverlay(
  settings: BrandKitSettings,
  image: OverlayImage | undefined,
  id: string,
  window: { readonly startMs: number; readonly endMs: number },
): LogoOverlay | undefined {
  if (image === undefined || !settings.logo.show || window.endMs <= window.startMs) {
    return undefined;
  }
  return {
    id,
    kind: "logo",
    startMs: window.startMs,
    endMs: window.endMs,
    image,
    corner: settings.logo.corner,
    sizePct: settings.logo.sizePct,
    opacity: settings.logo.opacity,
    marginPct: settings.logo.marginPct,
  };
}

/**
 * The end card for a clip, over `window` (its last seconds, on the source
 * clock), or `undefined` when the kit has it off or it would show nothing.
 * Ink and accent are the kit's where they read on the card's colour; where
 * they do not, render-core picks black or white.
 */
export function brandEndCardOverlay(
  settings: BrandKitSettings,
  image: OverlayImage | undefined,
  id: string,
  window: { readonly startMs: number; readonly endMs: number },
): EndCardOverlay | undefined {
  const card = settings.endCard;
  if (!card.enabled || window.endMs <= window.startMs) return undefined;
  const cta = card.cta.trim();
  const handle = card.handle.trim();
  const logo = card.showLogo ? image : undefined;
  if (cta === "" && handle === "" && logo === undefined) return undefined;
  const text =
    contrastRatio(settings.colors.text, card.background) >= READABLE
      ? settings.colors.text
      : undefined;
  const accent =
    contrastRatio(settings.colors.primary, card.background) >= READABLE
      ? settings.colors.primary
      : undefined;
  const fontFamily = settings.hookTitle.fontFamily ?? settings.captions.fontFamily;
  return {
    id,
    kind: "end-card",
    startMs: window.startMs,
    endMs: window.endMs,
    ...(cta === "" ? {} : { cta }),
    ...(handle === "" ? {} : { handle }),
    background: card.background,
    ...(text === undefined ? {} : { text }),
    ...(accent === undefined ? {} : { accent }),
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(logo === undefined ? {} : { image: logo }),
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID-shaped id that is always the same for the same `seed`, so a finishing
 * pass that runs twice, or twice at once, upserts one brand overlay rather than
 * adding a second (the hook title uses the clip shape's own id the same way).
 * Not a real ULID's time: it only has to be unique inside one document.
 */
export function stableOverlayId(seed: string): string {
  let out = "0";
  // Five FNV-1a passes with different offsets, five base-32 characters from
  // each: the 25 characters after the leading zero.
  for (let pass = 0; pass < 5; pass += 1) {
    let hash = (0x811c9dc5 ^ (pass * 0x9e3779b1)) >>> 0;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    for (let digit = 0; digit < 5 && out.length < 26; digit += 1) {
      out += CROCKFORD.charAt((hash >>> (digit * 5)) & 31);
    }
  }
  return out;
}
