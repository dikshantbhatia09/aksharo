/**
 * The brand kit page's sample clip (2026-10-02): a twelve-second vertical clip
 * with three captions, a hook title, the logo and the end card, built from the
 * kit being edited with the same builders Autopilot uses
 * (`@montaj/edg`'s `brand.ts`), so the preview is what a clip will get.
 */
import type { StyleDoc } from "@montaj/caption-styles";
import {
  brandCaptionOverrides,
  brandEndCardOverlay,
  brandHookAppearance,
  brandLogoOverlay,
  type BrandKitSettings,
  type OverlayImage,
} from "@montaj/edg";
import type { EdgProjection, OverlayTrack } from "@montaj/render-core";

export const PREVIEW_DURATION_MS = 12_000;

export const PREVIEW_CANVAS = { width: 1080, height: 1920 } as const;

/** Where the preview's moment buttons jump to. */
export type PreviewMoment = "opening" | "middle" | "end";

export function previewMomentMs(moment: PreviewMoment, settings: BrandKitSettings): number {
  switch (moment) {
    case "opening":
      return 1_300;
    case "middle":
      return 5_600;
    case "end":
      // Past the card's entry, a beat before the clip ends.
      return PREVIEW_DURATION_MS - Math.min(700, settings.endCard.durationMs / 3);
  }
}

const HOOK_TEXT = "Save more in five minutes a day";

const CAPTIONS: readonly { readonly words: readonly string[]; readonly keyword: number }[] = [
  { words: ["This", "is", "how", "every", "clip", "looks"], keyword: 3 },
  { words: ["Your", "colours,", "your", "fonts,", "your", "logo"], keyword: 5 },
  { words: ["Made", "for", "you,", "every", "time"], keyword: 4 },
];

/** Effects a keyword can wear (as Autopilot's finishing pass picks them). */
const KEYWORD_EFFECTS: ReadonlySet<unknown> = new Set([
  undefined,
  "none",
  "glow",
  "underline",
  "outline",
]);

function keywordPresetOf(style: StyleDoc): string | undefined {
  return style.emphasisPresets.find((preset) => KEYWORD_EFFECTS.has(preset.effect))?.id;
}

/**
 * The sample clip for `settings`, in `style`, with `logo` when the kit has one.
 * Pure: the page rebuilds it on every change, and the stage redraws.
 */
export function brandPreviewProjection(
  settings: BrandKitSettings,
  logo: OverlayImage | undefined,
  style: StyleDoc,
): EdgProjection {
  const keyword = keywordPresetOf(style);
  const overrides = brandCaptionOverrides(settings, {
    presets: style.emphasisPresets as unknown as readonly Readonly<Record<string, unknown>>[],
    ...(keyword === undefined ? {} : { keywordPresetId: keyword }),
  });

  const words: { wid: string; s: number; e: number; t: string }[] = [];
  const segments: EdgProjection["segments"][number][] = [];
  const span = 4_000;
  CAPTIONS.forEach((caption, index) => {
    const startMs = index * span;
    const each = (span - 200) / caption.words.length;
    caption.words.forEach((t, position) => {
      words.push({
        wid: `${String(index)}:${String(position)}`,
        t,
        s: Math.round(startMs + position * each),
        e: Math.round(startMs + (position + 1) * each),
      });
    });
    segments.push({
      id: `preview-${String(index)}`,
      seq: String.fromCharCode(0x41 + index),
      startWordId: `${String(index)}:0`,
      endWordId: `${String(index)}:${String(caption.words.length - 1)}`,
      startMs,
      endMs: startMs + span - 200,
      ...(keyword === undefined
        ? {}
        : {
            emphasis: [
              { wordId: `${String(index)}:${String(caption.keyword)}`, presetId: keyword },
            ],
          }),
    });
  });

  const overlays: OverlayTrack[] = [
    {
      id: "01JBRANDPREV1EWH00K0000000",
      kind: "hook-title",
      text: HOOK_TEXT,
      startMs: 0,
      endMs: 2_500,
      appearance: brandHookAppearance(settings),
    },
  ];
  const corner = brandLogoOverlay(settings, logo, "01JBRANDPREV1EWL0G00000000", {
    startMs: 0,
    endMs: PREVIEW_DURATION_MS,
  });
  if (corner !== undefined) overlays.push(corner);
  const card = brandEndCardOverlay(settings, logo, "01JBRANDPREV1EWCARD0000000", {
    startMs: PREVIEW_DURATION_MS - settings.endCard.durationMs,
    endMs: PREVIEW_DURATION_MS,
  });
  if (card !== undefined) overlays.push(card);

  return {
    canvas: PREVIEW_CANVAS,
    styles: {
      defaultStyleId: style.id,
      ...(overrides === undefined ? {} : { inline: { doc: overrides } }),
    },
    segments,
    words,
    overlays,
  };
}
