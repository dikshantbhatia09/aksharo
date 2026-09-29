import { createHash } from "node:crypto";

import { contrastRatio, type BrandKitSettings, type OverlayImage } from "@montaj/edg";
import {
  COMPILATION_LIMITS,
  compilationOutputMs,
  type CompilationIntro,
} from "@montaj/repurpose-contracts";

import { COMPILATION_ERRORS, type CompilationShape } from "./compilations.dto.js";
import { ASPECT_OF_SHAPE } from "./repurpose.constants.js";
import { isRemoved } from "./steering.js";

/**
 * The decisions a compilation is made of (2026-10-03), kept pure so each is
 * tested on its own: which clips can be joined in a shape, what makes two
 * requests the same compilation, how long it comes out, what its title card
 * looks like, and what its failure is called on the run page.
 */

/** The title card's words as stored: spaces collapsed; nothing left means no card. */
export function titleOf(raw: string | null | undefined): string | null {
  const title = (raw ?? "").replace(/\s+/gu, " ").trim();
  return title === "" ? null : title.slice(0, COMPILATION_LIMITS.titleMax);
}

/**
 * What makes two requests the same compilation: the same clips in the same
 * order, the same shape and the same title card. Hashed, so the unique index
 * stays small whatever the list.
 */
export function compilationFingerprint(input: {
  readonly clipIds: readonly string[];
  readonly shape: CompilationShape;
  readonly title: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ v: 1, clipIds: input.clipIds, shape: input.shape, title: input.title }),
    )
    .digest("hex");
}

/** A clip's captioned video in one shape: what a compilation joins. */
export interface ShapeVideo {
  readonly clipId: string;
  readonly exportId: string;
  readonly key: string;
  readonly durationMs: number;
  readonly watermarked: boolean;
}

/** The slice of a clip row (with its variants and their newest exports) this reads. */
export interface ClipWithShapes {
  readonly id: string;
  readonly candidate: { readonly state: string };
  readonly variants: readonly {
    readonly aspect: string;
    readonly status: string;
    readonly latestExport: {
      readonly id: string;
      readonly status: string;
      readonly storageKey: string | null;
      readonly durationMs: number | null;
      readonly watermarked: boolean;
    } | null;
  }[];
}

/**
 * The clip's captioned video in `shape`, when it can be joined: the clip is
 * not a removed moment's, and its shape's captioned video is made and still
 * stored (a video being made again after an edit keeps its variant `stale`
 * until the new one lands, and is joined once it has).
 */
export function captionedVideoOf(clip: ClipWithShapes, shape: CompilationShape): ShapeVideo | null {
  if (isRemoved(clip.candidate)) return null;
  // eslint-disable-next-line security/detect-object-injection -- a closed enum of shapes
  const aspect = ASPECT_OF_SHAPE[shape];
  const variant = clip.variants.find((row) => row.aspect === aspect);
  const made = variant?.latestExport ?? null;
  if (
    variant === undefined ||
    variant.status !== "ready" ||
    made === null ||
    made.status !== "succeeded" ||
    made.storageKey === null ||
    made.durationMs === null ||
    made.durationMs <= 0
  ) {
    return null;
  }
  return {
    clipId: clip.id,
    exportId: made.id,
    key: made.storageKey,
    durationMs: made.durationMs,
    watermarked: made.watermarked,
  };
}

/** The joined video's length: the contract's own sum, with the card when there is one. */
export function plannedDurationMs(
  videos: readonly Pick<ShapeVideo, "durationMs">[],
  title: string | null,
): number {
  return compilationOutputMs({
    clipsMs: videos.map((video) => video.durationMs),
    ...(title === null ? {} : { introMs: COMPILATION_LIMITS.introMs }),
  });
}

/** The product's own card, for a workspace with no brand kit: its page colours. */
export const DEFAULT_INTRO_COLOURS = Object.freeze({ background: "#141217", text: "#f1ece6" });

/** Words read on a card at 3:1, as the brand kit's own end card holds them. */
const READABLE = 3;

/**
 * The title card: the brand kit's end-card colour, words in its text colour
 * and the handle in its primary where they read on it, its hook typeface (else
 * its captions'), its handle, and its logo - or, with no kit, the title in the
 * product's own colours and nothing else.
 */
export function introOf(
  title: string,
  kit: { readonly settings: BrandKitSettings; readonly logo?: OverlayImage } | null,
): CompilationIntro {
  if (kit === null) {
    return { title, durationMs: COMPILATION_LIMITS.introMs, ...DEFAULT_INTRO_COLOURS };
  }
  const { settings } = kit;
  const background = settings.endCard.background;
  const handle = settings.endCard.handle.trim();
  const fontFamily = settings.hookTitle.fontFamily ?? settings.captions.fontFamily;
  return {
    title,
    durationMs: COMPILATION_LIMITS.introMs,
    background,
    ...(contrastRatio(settings.colors.text, background) >= READABLE
      ? { text: settings.colors.text }
      : {}),
    ...(contrastRatio(settings.colors.primary, background) >= READABLE
      ? { accent: settings.colors.primary }
      : {}),
    ...(handle === "" ? {} : { handle: handle.slice(0, 40) }),
    ...(fontFamily === undefined ? {} : { fontFamily }),
    ...(kit.logo === undefined ? {} : { logo: kit.logo }),
  };
}

/**
 * The code a compilation fails with, from its job's: a stable set the run page
 * has a sentence and an action for, never a worker's own words.
 */
export function compilationFailureOf(jobErrorCode: string | null | undefined): string {
  switch (jobErrorCode) {
    case "storage/unreadable":
    case "render/no-video-stream":
      return COMPILATION_ERRORS.sourceGone;
    case "render/compilation-too-long":
      return COMPILATION_ERRORS.tooLong;
    case "jobs/cancelled":
      return COMPILATION_ERRORS.cancelled;
    case "jobs/stalled":
    case "jobs/queue_timeout":
      return COMPILATION_ERRORS.stalled;
    default:
      return jobErrorCode?.startsWith("credits/") === true
        ? COMPILATION_ERRORS.noCredits
        : COMPILATION_ERRORS.failed;
  }
}

/** A compilation's `sources` as stored: what an attempt joined. */
export interface StoredSource {
  readonly clipId: string;
  readonly exportId: string;
  readonly durationMs: number;
}

export function storedSourcesOf(value: unknown): StoredSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StoredSource =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as StoredSource).clipId === "string" &&
      typeof (entry as StoredSource).exportId === "string" &&
      typeof (entry as StoredSource).durationMs === "number",
  );
}

/** The clip ids as stored, in playing order. */
export function clipIdsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Whether a made compilation's clips have moved on since: a clip's captioned
 * video is now another file (its captions were edited, or it was cut again),
 * or it cannot be joined at all any more. "Make again" joins the current ones.
 */
export function sourcesChanged(
  sources: readonly StoredSource[],
  current: ReadonlyMap<string, ShapeVideo | null>,
): boolean {
  return sources.some((source) => current.get(source.clipId)?.exportId !== source.exportId);
}
