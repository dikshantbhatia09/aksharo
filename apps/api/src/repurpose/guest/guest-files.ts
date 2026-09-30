import {
  ClipCopySchema,
  DUB_LANGUAGE_NAMES,
  IMAGE_FILE_IDS,
  VIDEO_SHAPES,
  VIDEO_SHAPE_SIZE,
  type DubLanguage,
  type ImageFileId,
  type VideoShape,
} from "@montaj/repurpose-contracts";

import { fileOfImage, storedImagesOf } from "../clip-images.js";
import { mayPost, type ApprovalCheck } from "../review/review-state.js";

import type { GuestPostView } from "./guest.dto.js";

/**
 * What a guest page offers of one clip (2026-10-05), decided before anything
 * is signed: pure, so the rules are tested on their own and the service only
 * reads rows and signs the keys this chooses.
 *
 * **Every file is one the team already has.** A captioned video per shape is
 * the one review and posting use (`review-videos.ts`: Autopilot's render, else
 * the newest export made by hand); the clean cut is the shape's own project's
 * primary media; the images are the clip's stored set; a dubbed version is a
 * dub's shape with its newest captioned export. Nothing is made for the page.
 *
 * **Approval before posting holds here too.** When the workspace requires
 * approval (`ClipApprovalGate`), a guest reposting a clip is the clip going
 * out, so the page offers only what posting could send: a shape whose
 * captioned video the approval covers (and that shape's clean cut), images
 * taken from covered videos only, and dubbed versions of an approved clip. A
 * clip with nothing covered is not on the page yet.
 */

/** One shape's files, before signing. */
export interface ShapeFiles {
  readonly shape: VideoShape;
  /** The captioned video's key, or null when only the clean cut exists. */
  readonly captionedKey: string | null;
  readonly cleanKey: string | null;
}

export interface GuestClipPlan {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number | null;
  readonly player: {
    readonly shape: VideoShape;
    readonly key: string;
    readonly captioned: boolean;
    readonly posterKey: string | null;
  } | null;
  readonly videos: readonly ShapeFiles[];
  readonly images: readonly {
    readonly id: ImageFileId;
    readonly width: number;
    readonly height: number;
    readonly name: string;
    readonly keys: readonly { readonly key: string; readonly name: string }[];
  }[];
  readonly dubs: readonly {
    readonly language: DubLanguage;
    readonly name: string;
    readonly videos: readonly ShapeFiles[];
  }[];
  readonly hashtags: readonly string[];
  readonly posts: readonly GuestPostView[];
}

/** One clip's captioned video in one shape, as `reviewVideosOf` reads it. */
export interface CaptionedVideo {
  readonly exportId: string;
  readonly storageKey: string;
  readonly durationMs: number | null;
}

/** A dub's files in one language: per shape, its captioned video and clean cut. */
export interface DubFiles {
  readonly language: DubLanguage;
  readonly shapes: ReadonlyMap<
    VideoShape,
    { readonly captionedKey: string | null; readonly cleanKey: string | null }
  >;
}

export interface GuestClipInput {
  readonly id: string;
  readonly title: string;
  /** `repurpose_clips.copy`: `ClipCopySchema`, or `{}` when none was written. */
  readonly copy: unknown;
  /** `repurpose_clips.images`: `{ fingerprint, images }`, or `{}`. */
  readonly images: unknown;
  readonly durationMs: number | null;
  readonly captioned: ReadonlyMap<VideoShape, CaptionedVideo>;
  /** The clean cut's key per shape. */
  readonly clean: ReadonlyMap<VideoShape, string>;
  readonly approval: ApprovalCheck;
  /** The clip's dubbed versions; empty when the link leaves them out. */
  readonly dubs: readonly DubFiles[];
}

/** The still a player shows before it plays, per shape: a frame of that captioned video. */
const POSTER_OF_SHAPE: Readonly<Record<VideoShape, ImageFileId>> = {
  "9:16": "vertical-image",
  "4:5": "portrait-post",
  "1:1": "square-post",
  "16:9": "thumbnail",
};

/**
 * The export ids a stored image set was taken from, and the shapes of its clean
 * frames, read from its fingerprint (`planClipImages`: `9:16:<exportId>`,
 * `16:9:clean:<mediaId>`, either with an `@<length>` suffix, comma-joined).
 */
export function imageSources(fingerprint: string): {
  readonly exportIds: readonly string[];
  readonly cleanShapes: readonly VideoShape[];
} {
  const exportIds: string[] = [];
  const cleanShapes: VideoShape[] = [];
  for (const entry of fingerprint.split(",")) {
    const shape = VIDEO_SHAPES.find((candidate) => entry.startsWith(`${candidate}:`));
    if (shape === undefined) continue;
    const rest = entry.slice(shape.length + 1).split("@")[0] ?? "";
    if (rest.startsWith("clean:")) cleanShapes.push(shape);
    else if (rest !== "") exportIds.push(rest);
  }
  return { exportIds, cleanShapes };
}

/** "Clip title 9x16" - what a downloaded file is called, before its extension. */
export function fileStem(title: string, ...parts: readonly string[]): string {
  const base = title.trim().slice(0, 70) || "clip";
  return [base, ...parts].join(" ");
}

/** The words to post a clip with, from its copy: a caption for any platform, then each platform's. */
export function postsOf(copyValue: unknown): {
  readonly hashtags: readonly string[];
  readonly posts: readonly GuestPostView[];
} {
  const parsed = ClipCopySchema.safeParse(copyValue);
  if (!parsed.success) return { hashtags: [], posts: [] };
  const copy = parsed.data;
  const description = (copy.description ?? "").trim() || copy.summary.trim();
  const tags = copy.hashtags.join(" ");
  const caption = [description, tags].filter((part) => part !== "").join("\n\n");
  const posts: GuestPostView[] = [];
  const title = copy.title?.trim() ?? "";
  if (caption !== "" || title !== "") {
    posts.push({ platform: "any", title: title === "" ? null : title, text: caption });
  }
  const platforms = copy.platforms ?? {};
  if (platforms.instagram !== undefined) {
    posts.push({ platform: "instagram", title: null, text: platforms.instagram.caption });
  }
  if (platforms.youtube !== undefined) {
    posts.push({
      platform: "youtube",
      title: platforms.youtube.title,
      text: platforms.youtube.description,
    });
  }
  if (platforms.tiktok !== undefined) {
    posts.push({ platform: "tiktok", title: null, text: platforms.tiktok.caption });
  }
  if (platforms.facebook !== undefined) {
    posts.push({ platform: "facebook", title: null, text: platforms.facebook.text });
  }
  if (platforms.linkedin !== undefined) {
    posts.push({ platform: "linkedin", title: null, text: platforms.linkedin.text });
  }
  if (platforms.x !== undefined) {
    posts.push({ platform: "x", title: null, text: platforms.x.text });
  }
  return { hashtags: copy.hashtags, posts };
}

/**
 * What the page offers of one clip, or null when it offers nothing yet (no cut
 * or video at all, or nothing the approval covers): such a clip is counted as
 * coming, never shown half-made.
 */
export function planGuestClip(input: GuestClipInput): GuestClipPlan | null {
  const gated = input.approval.required;
  const captioned = new Map<VideoShape, CaptionedVideo>();
  for (const shape of VIDEO_SHAPES) {
    const video = input.captioned.get(shape);
    if (video === undefined) continue;
    if (gated && !mayPost(input.approval, video.exportId)) continue;
    captioned.set(shape, video);
  }

  const videos: ShapeFiles[] = [];
  for (const shape of VIDEO_SHAPES) {
    const video = captioned.get(shape);
    // Under approval a clean cut goes with its approved shape, never alone.
    const cleanKey = gated && video === undefined ? null : (input.clean.get(shape) ?? null);
    if (video === undefined && cleanKey === null) continue;
    videos.push({ shape, captionedKey: video?.storageKey ?? null, cleanKey });
  }
  if (videos.length === 0) return null;

  const images = imagesOf(input, captioned);
  const player = playerOf(videos, images);

  const dubs =
    gated && captioned.size === 0
      ? []
      : input.dubs.flatMap((dub) => {
          const shapes: ShapeFiles[] = [];
          for (const shape of VIDEO_SHAPES) {
            const files = dub.shapes.get(shape);
            if (files === undefined) continue;
            if (files.captionedKey === null && files.cleanKey === null) continue;
            shapes.push({ shape, captionedKey: files.captionedKey, cleanKey: files.cleanKey });
          }
          return shapes.length === 0
            ? []
            : [{ language: dub.language, name: DUB_LANGUAGE_NAMES[dub.language], videos: shapes }];
        });

  const { hashtags, posts } = postsOf(input.copy);
  return {
    id: input.id,
    title: input.title,
    durationMs: captioned.get("9:16")?.durationMs ?? input.durationMs,
    player,
    videos,
    images,
    dubs,
    hashtags,
    posts,
  };
}

/** The stored images, grouped per file, when the approval (if any) covers what they came from. */
function imagesOf(
  input: GuestClipInput,
  captioned: ReadonlyMap<VideoShape, CaptionedVideo>,
): GuestClipPlan["images"] {
  const stored = storedImagesOf(input.images);
  if (stored === null || stored.images.length === 0) return [];
  if (input.approval.required) {
    if (input.approval.state !== "approved") return [];
    const sources = imageSources(stored.fingerprint);
    if (sources.exportIds.length === 0 && sources.cleanShapes.length === 0) return [];
    if (!sources.exportIds.every((exportId) => input.approval.covered.has(exportId))) return [];
    if (!sources.cleanShapes.every((shape) => captioned.has(shape))) return [];
  }
  const files = new Map<
    ImageFileId,
    {
      id: ImageFileId;
      width: number;
      height: number;
      name: string;
      keys: { key: string; name: string }[];
    }
  >();
  for (const image of stored.images) {
    const id = fileOfImage(image.name);
    if (id === null) continue;
    const file = files.get(id) ?? {
      id,
      width: image.width,
      height: image.height,
      name: image.name,
      keys: [],
    };
    file.keys.push({ key: image.key, name: image.name });
    files.set(id, file);
  }
  // In the order the formats list them, not the order they were stored.
  return [...files.values()].sort(
    (a, b) => IMAGE_FILE_IDS.indexOf(a.id) - IMAGE_FILE_IDS.indexOf(b.id),
  );
}

/**
 * The video the page plays: the captioned 9:16 first (what every platform
 * takes), else another captioned shape, else a clean cut; with a still of the
 * same captioned video before it plays, when the images include one.
 */
function playerOf(
  videos: readonly ShapeFiles[],
  images: GuestClipPlan["images"],
): GuestClipPlan["player"] {
  const ordered = [
    ...videos.filter((video) => video.shape === "9:16"),
    ...videos.filter((video) => video.shape !== "9:16"),
  ];
  const withCaptions = ordered.find((video) => video.captionedKey !== null);
  if (withCaptions !== undefined && withCaptions.captionedKey !== null) {
    const posterId = POSTER_OF_SHAPE[withCaptions.shape];
    const poster = images.find((image) => image.id === posterId)?.keys[0]?.key ?? null;
    return {
      shape: withCaptions.shape,
      key: withCaptions.captionedKey,
      captioned: true,
      posterKey: poster,
    };
  }
  const clean = ordered.find((video) => video.cleanKey !== null);
  return clean === undefined || clean.cleanKey === null
    ? null
    : { shape: clean.shape, key: clean.cleanKey, captioned: false, posterKey: null };
}

/** A shape's pixel size, for the page to say "1080 x 1920". */
export function shapeSize(shape: VideoShape): { readonly width: number; readonly height: number } {
  // eslint-disable-next-line security/detect-object-injection -- a closed union key
  return VIDEO_SHAPE_SIZE[shape];
}
