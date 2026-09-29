import { contrastRatio, type BrandKitSettings } from "@montaj/edg";
import type { Audiogram } from "@montaj/repurpose-contracts";

/**
 * Audiograms (2026-10-04): what a clip of a source with no picture is drawn
 * with. `media.clip` draws it (`apps/worker-media/src/processors/audiogram.ts`);
 * this decides the colours and the artwork.
 *
 * - **Colours.** A run that uses the brand kit (`setup.brand`) and a workspace
 *   that has one: the kit's secondary colour for the ground (where its end
 *   card starts too) and its primary for the waveform. Otherwise a calm dark
 *   ground and a light waveform, the product's own. A waveform that would not
 *   read on its ground (a kit whose two colours are close) is drawn in black
 *   or white instead, whichever reads.
 * - **Artwork.** The cover the person gave when they started the run, else
 *   the kit's logo (again only for a run that uses the kit), else none.
 */

/** The ground and the waveform without a brand kit: the app's own ground, and its light ink. */
export const AUDIOGRAM_DEFAULT_COLOURS = {
  background: "#141217",
  accent: "#f1ece6",
} as const;

/** A waveform is a thin, busy shape: it needs at least this contrast on its ground to read. */
const WAVEFORM_CONTRAST = 3;

/** An image the worker reads from the derived store, and its type. */
export interface AudiogramArtwork {
  readonly key: string;
  readonly format: "png" | "jpeg" | "webp";
}

export interface AudiogramInputs {
  /** The workspace's kit, when the run uses it and there is one; `null` otherwise. */
  readonly kit: { readonly settings: BrandKitSettings; readonly logo?: AudiogramArtwork } | null;
  /** The cover the person gave with the run, when it is still kept. */
  readonly cover: AudiogramArtwork | null;
}

/** The payload's `audiogram` for a cut of a source with no picture. */
export function audiogramOf(inputs: AudiogramInputs): Audiogram {
  const colours =
    inputs.kit === null
      ? AUDIOGRAM_DEFAULT_COLOURS
      : {
          background: inputs.kit.settings.colors.secondary,
          accent: readableOn(
            inputs.kit.settings.colors.secondary,
            inputs.kit.settings.colors.primary,
          ),
        };
  const artwork = inputs.cover ?? inputs.kit?.logo ?? null;
  return {
    background: colours.background.toLowerCase(),
    accent: colours.accent.toLowerCase(),
    ...(artwork === null ? {} : { artwork: { key: artwork.key, format: artwork.format } }),
  };
}

/** `accent` when it reads on `ground`; else black or white, whichever reads better. */
export function readableOn(ground: string, accent: string): string {
  if (contrastRatio(ground, accent) >= WAVEFORM_CONTRAST) return accent;
  return contrastRatio(ground, "#ffffff") >= contrastRatio(ground, "#000000")
    ? "#ffffff"
    : "#000000";
}

/**
 * The cover a run was started with (`config.audiogram.coverAssetId`), or
 * `undefined`: every run from before audiograms, and every run given none.
 */
export function coverAssetIdOf(run: { readonly config: unknown }): string | undefined {
  const config = run.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const audiogram = (config as Record<string, unknown>)["audiogram"];
  if (typeof audiogram !== "object" || audiogram === null || Array.isArray(audiogram)) {
    return undefined;
  }
  const id = (audiogram as Record<string, unknown>)["coverAssetId"];
  return typeof id === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id) ? id : undefined;
}

/**
 * Whether a probed source has no picture: an audio-only file, or one whose
 * only image is an attached cover (the probe reads that as no video). A source
 * not probed yet is never cut, so this is only asked of a ready one.
 */
export function hasNoPicture(media: {
  readonly width: number | null;
  readonly height: number | null;
}): boolean {
  return media.width === null || media.height === null;
}
