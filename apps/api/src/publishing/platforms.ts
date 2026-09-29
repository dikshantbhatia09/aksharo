import type { PublishProvider } from "./publishing.contract.js";

/**
 * Where a clip can be posted from Aksharo, and the file and words each place
 * takes (2026-09-29).
 *
 * The shapes follow `@montaj/repurpose-contracts`' `FORMAT_TARGETS` where a
 * target fits (Reels, Shorts, TikTok and Threads are 9:16; a feed post is 4:5;
 * X takes 16:9 or square) plus LinkedIn, which that list does not cover:
 * square first, which does well in the LinkedIn and X feeds. The first shape
 * that has a finished captioned video wins; 9:16 is always the last resort,
 * since every one of these places takes a vertical video.
 *
 * The text limits are the ones Postiz enforces for each provider
 * (`maxLength()` in its provider classes), which is where a longer text would
 * be refused; the duration limits come from `FORMAT_TARGETS`.
 */

export const VIDEO_SHAPES = ["9:16", "4:5", "1:1", "16:9"] as const;
export type VideoShape = (typeof VIDEO_SHAPES)[number];

/** The providers this module posts to; the contract also names Snapchat and WhatsApp. */
export const SUPPORTED_PROVIDERS = [
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "linkedin",
  "x",
  "threads",
] as const satisfies readonly PublishProvider[];
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export interface PlatformRules {
  readonly provider: SupportedProvider;
  /** The platform's name, as a person says it. */
  readonly label: string;
  /** What the post becomes there. */
  readonly surface: string;
  /** Shape preference, best first. */
  readonly shapes: readonly VideoShape[];
  /** The longest video it takes this way, when a clip could reach it. */
  readonly maxDurationMs: number | null;
  /** The longest post text, in the platform's own counting. */
  readonly bodyLimit: number;
  /** A separate title field (YouTube's title; TikTok's optional one). */
  readonly titleLimit: number | null;
  readonly titleRequired: boolean;
  /** Hashtags a default text carries; more reads as spam on most of these. */
  readonly hashtags: number;
  /** X counts a link as 23 characters and some characters as two. */
  readonly weightedCount: boolean;
}

export const PLATFORM_RULES: Readonly<Record<SupportedProvider, PlatformRules>> = Object.freeze({
  instagram: {
    provider: "instagram",
    label: "Instagram",
    surface: "Reel",
    shapes: ["9:16"],
    maxDurationMs: 180_000,
    bodyLimit: 2_200,
    titleLimit: null,
    titleRequired: false,
    hashtags: 5,
    weightedCount: false,
  },
  facebook: {
    provider: "facebook",
    label: "Facebook",
    // Postiz posts a Page video to the feed (`/{page}/videos`), not as a Reel.
    surface: "Feed video",
    shapes: ["4:5", "9:16"],
    maxDurationMs: null,
    // Facebook itself takes far more; the clip's own Facebook text is capped here.
    bodyLimit: 5_000,
    titleLimit: null,
    titleRequired: false,
    hashtags: 3,
    weightedCount: false,
  },
  youtube: {
    provider: "youtube",
    label: "YouTube",
    surface: "Short",
    shapes: ["9:16"],
    maxDurationMs: 180_000,
    bodyLimit: 5_000,
    titleLimit: 100,
    titleRequired: true,
    hashtags: 3,
    weightedCount: false,
  },
  tiktok: {
    provider: "tiktok",
    label: "TikTok",
    surface: "Video",
    shapes: ["9:16"],
    maxDurationMs: null,
    bodyLimit: 2_000,
    titleLimit: 90,
    titleRequired: false,
    hashtags: 5,
    weightedCount: false,
  },
  linkedin: {
    provider: "linkedin",
    label: "LinkedIn",
    surface: "Video",
    shapes: ["1:1", "4:5", "9:16"],
    maxDurationMs: null,
    bodyLimit: 3_000,
    titleLimit: null,
    titleRequired: false,
    hashtags: 3,
    weightedCount: false,
  },
  x: {
    provider: "x",
    label: "X",
    surface: "Video",
    shapes: ["1:1", "16:9", "9:16"],
    // A standard account posts up to 2 min 20 s (`FORMAT_TARGETS` x-video).
    maxDurationMs: 140_000,
    bodyLimit: 280,
    titleLimit: null,
    titleRequired: false,
    hashtags: 2,
    weightedCount: true,
  },
  threads: {
    provider: "threads",
    label: "Threads",
    surface: "Video",
    shapes: ["9:16"],
    maxDurationMs: 300_000,
    bodyLimit: 500,
    titleLimit: null,
    titleRequired: false,
    // Threads links one topic per post.
    hashtags: 1,
    weightedCount: false,
  },
});

export function rulesFor(provider: SupportedProvider): PlatformRules {
  // eslint-disable-next-line security/detect-object-injection -- a closed union key
  return PLATFORM_RULES[provider];
}

/** What a shape is called in a sentence. */
export function shapeWords(shape: VideoShape): string {
  switch (shape) {
    case "9:16":
      return "vertical (9:16)";
    case "4:5":
      return "4:5";
    case "1:1":
      return "square";
    case "16:9":
      return "wide (16:9)";
  }
}

export interface ShapeChoice {
  /** The shape posted, or null when no captioned video is ready in any that fits. */
  readonly shape: VideoShape | null;
  /** One sentence when the choice needs explaining: a fallback, or nothing to post. */
  readonly note: string | null;
}

/**
 * The shape to post for `provider`, given which shapes have a finished
 * captioned video (`ready`) and which are still being made (`making`).
 */
export function chooseShape(
  provider: SupportedProvider,
  ready: ReadonlySet<VideoShape>,
  making: ReadonlySet<VideoShape>,
): ShapeChoice {
  const rules = rulesFor(provider);
  const order: VideoShape[] = [...rules.shapes];
  if (!order.includes("9:16")) order.push("9:16");
  const chosen = order.find((shape) => ready.has(shape)) ?? null;
  if (chosen === null) {
    return {
      shape: null,
      note:
        making.size > 0 ? "Its video is still being made." : "No finished video with captions yet.",
    };
  }
  const preferred = order[0];
  if (preferred !== undefined && chosen !== preferred && making.has(preferred)) {
    return {
      shape: chosen,
      note: `The ${shapeWords(preferred)} video is still being made, so this posts the ${shapeWords(chosen)} one.`,
    };
  }
  return { shape: chosen, note: null };
}

/** `2:20` from 140 000 ms. */
export function clock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/** A sentence when the clip is longer than `provider` takes, else null. */
export function tooLongFor(provider: SupportedProvider, durationMs: number | null): string | null {
  const limit = rulesFor(provider).maxDurationMs;
  // A second of slack: the cut keeps short handles either side of the moment.
  if (limit === null || durationMs === null || durationMs <= limit + 1_000) return null;
  return `Too long for ${rulesFor(provider).label}: ${clock(limit)} at most.`;
}
