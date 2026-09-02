/**
 * B17 preset: maps `me.onboarding.defaultExportPreset` — a free-form label
 * B17's onboarding flow writes from the "what you make?" step
 * (`apps/web/app/(app)/onboarding/onboarding-flow.tsx`'s `MAKE_DEFAULTS`,
 * e.g. `"reels"`, `"youtube"`, `"podcast-clip"`, `"client-review"`,
 * `"highlights"`) — onto this dialog's own named-preset concept: a small,
 * closed table of (resolution + aspect + codec/quality tier) presets, each
 * backed by one of `@montaj/render-manifest`'s frozen `RenderPreset` values
 * (`"reels" | "shorts" | "youtube-4k" | "square" | "custom"` — never
 * extended here, per the file boundary).
 *
 * Two labels do not have a matching aspect in `RenderPreset` today: B17's
 * `"youtube"` and `"client-review"` both mean 16:9 landscape, and the only
 * 16:9 option this dialog offers is `youtube-4k` (`packages/render-manifest`
 * has no 1080p 16:9 preset) — so both fall back to the closest available
 * aspect rather than a fabricated resolution. Reported as an open gap in the
 * final report, not silently "fixed" by inventing a preset value outside the
 * frozen enum.
 */

import type { RenderPreset } from "@montaj/render-manifest";

export interface NamedExportPreset {
  readonly id: string;
  readonly label: string;
  readonly aspect: "9:16" | "16:9" | "1:1" | "4:5";
  readonly preset: RenderPreset;
}

/**
 * The dialog's own named-preset table. `id` is not B17's raw label —
 * `resolveOnboardingExportPreset` maps from B17's label to one of these ids —
 * so a future onboarding label change only touches the mapping, not the
 * table.
 */
export const NAMED_EXPORT_PRESETS: readonly NamedExportPreset[] = [
  {
    id: "reels-1080-vertical",
    label: "Reels / TikTok (1080×1920)",
    aspect: "9:16",
    preset: "reels",
  },
  {
    id: "shorts-1080-vertical",
    label: "YouTube Shorts (1080×1920)",
    aspect: "9:16",
    preset: "shorts",
  },
  // No 1080p 16:9 `RenderPreset` exists yet (see the module header); this
  // named preset's *label* says 1080 because that is what B17's "youtube"
  // and "client-review" answers mean, but it renders through `youtube-4k`
  // (the only 16:9 option in the frozen enum) until one is added.
  { id: "youtube-1080", label: "YouTube (16:9)", aspect: "16:9", preset: "youtube-4k" },
  { id: "podcast-clip", label: "Podcast clip (1080×1080)", aspect: "1:1", preset: "square" },
  { id: "client-review", label: "Client review (16:9)", aspect: "16:9", preset: "youtube-4k" },
  {
    id: "highlights-1080-vertical",
    label: "Highlights (1080×1920)",
    aspect: "9:16",
    preset: "reels",
  },
];

const DEFAULT_NAMED_PRESET_ID = "reels-1080-vertical";

/** B17's raw `onboarding.defaultExportPreset` label -> this dialog's named-preset id. */
const ONBOARDING_LABEL_TO_NAMED_PRESET_ID: Readonly<Record<string, string>> = {
  reels: "reels-1080-vertical",
  youtube: "youtube-1080",
  "podcast-clip": "podcast-clip",
  "client-review": "client-review",
  highlights: "highlights-1080-vertical",
};

function namedPresetById(id: string): NamedExportPreset {
  const found = NAMED_EXPORT_PRESETS.find((entry) => entry.id === id);
  if (found !== undefined) return found;
  const fallback = NAMED_EXPORT_PRESETS.find((entry) => entry.id === DEFAULT_NAMED_PRESET_ID);
  if (fallback === undefined) throw new Error("NAMED_EXPORT_PRESETS has no default entry");
  return fallback;
}

/**
 * Resolves `me.onboarding.defaultExportPreset` to the named preset the
 * dialog should pre-select. Falls back to the dialog's own default
 * (`"reels-1080-vertical"`) when the field is absent (a user who onboarded
 * before B17, or skipped the "what you make?" step) or carries a label this
 * table does not recognise (a future onboarding option this dialog has not
 * been taught yet) — never throws either way.
 */
export function resolveOnboardingExportPreset(
  defaultExportPreset: string | null | undefined,
): NamedExportPreset {
  if (defaultExportPreset === null || defaultExportPreset === undefined) {
    return namedPresetById(DEFAULT_NAMED_PRESET_ID);
  }
  const namedPresetId = ONBOARDING_LABEL_TO_NAMED_PRESET_ID[defaultExportPreset];
  if (namedPresetId === undefined) return namedPresetById(DEFAULT_NAMED_PRESET_ID);
  return namedPresetById(namedPresetId);
}
