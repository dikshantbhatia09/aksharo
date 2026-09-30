import { z } from "zod";

import {
  DUB_LANGUAGES,
  IMAGE_FILE_IDS,
  VIDEO_SHAPES,
  type ImageFileId,
  type VideoShape,
} from "@montaj/repurpose-contracts";

import {
  GUEST_LINK_DEFAULT_DAYS,
  GUEST_LINK_MAX_DAYS,
  GUEST_LINK_MIN_DAYS,
  GUEST_NAME_MAX,
  MAX_CLIPS_PER_GUEST_LINK,
} from "./guest.constants.js";
import { zodDto } from "../../common/index.js";

/**
 * Request and response shapes for guest pages (2026-10-05): the team's routes
 * under `/repurpose/runs/{runId}/guest-links` and the guest's under `/guest`.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const clipIdSchema = z.string().regex(ULID, "must be a clip id");

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Control characters out, runs of space folded: the name is shown on the page. */
function clean(value: string): string {
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

// --- The team's routes -------------------------------------------------------

/**
 * `POST /repurpose/runs/{runId}/guest-links`: every clip of the run
 * (`allClips`, clips made later included) or the clips named in `clipIds`,
 * never both and never neither.
 */
export const createGuestLinkSchema = z
  .object({
    allClips: z.boolean().default(false),
    clipIds: z.array(clipIdSchema).max(MAX_CLIPS_PER_GUEST_LINK).default([]),
    guestName: z
      .string()
      .max(GUEST_NAME_MAX * 2)
      .transform(clean)
      .pipe(z.string().max(GUEST_NAME_MAX))
      .optional(),
    expiresInDays: z
      .number()
      .int()
      .min(GUEST_LINK_MIN_DAYS)
      .max(GUEST_LINK_MAX_DAYS)
      .default(GUEST_LINK_DEFAULT_DAYS),
    includeDubs: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.allClips && value.clipIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["clipIds"],
        message: "Share every clip, or name the clips to share, not both.",
      });
    }
    if (!value.allClips && value.clipIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["clipIds"],
        message: "Choose at least one clip, or share every clip.",
      });
    }
  });
export class CreateGuestLinkDto extends zodDto(createGuestLinkSchema) {}
export type CreateGuestLinkInput = z.infer<typeof createGuestLinkSchema>;

// --- The guest's routes ------------------------------------------------------

/** The kinds of file a guest page offers, as a download is counted. */
export const GUEST_FILE_KINDS = ["video", "clean", "image", "dub", "dub-clean"] as const;
export type GuestFileKind = (typeof GUEST_FILE_KINDS)[number];

/**
 * `POST /guest/downloads`: one file downloaded from the page, counted. Says
 * which, for the audit trail; the download itself never waits on it.
 */
export const guestDownloadSchema = z.object({
  clipId: clipIdSchema,
  file: z.enum(GUEST_FILE_KINDS),
  shape: z.enum(VIDEO_SHAPES).optional(),
  image: z.enum(IMAGE_FILE_IDS).optional(),
  language: z.enum(DUB_LANGUAGES).optional(),
});
export class GuestDownloadDto extends zodDto(guestDownloadSchema) {}
export type GuestDownloadInput = z.infer<typeof guestDownloadSchema>;

// --- Views -------------------------------------------------------------------

/** A guest link, as the run page lists it. Never the link itself. */
export interface GuestLinkView {
  readonly id: string;
  readonly runId: string;
  readonly hint: string;
  readonly guestName: string | null;
  /** Every clip of the run, clips made later included. */
  readonly allClips: boolean;
  /** The clips named, when not every clip: those still on the run. */
  readonly clipIds: readonly string[];
  /** How many of the run's clips it shares now. */
  readonly clipCount: number;
  readonly includeDubs: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly status: "live" | "expired" | "revoked";
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly visits: number;
  readonly lastVisitAt: string | null;
  readonly downloads: number;
  readonly lastDownloadAt: string | null;
}

/** A link as it is made: the only time the full address exists outside the page it opens. */
export interface CreatedGuestLinkView extends GuestLinkView {
  readonly url: string;
}

// --- The guest's page --------------------------------------------------------

/** One video file of one shape: with its captions burned in, and the clean cut. */
export interface GuestVideoView {
  readonly shape: VideoShape;
  readonly width: number;
  readonly height: number;
  /** The video with captions, signed as a download; null when only the clean cut exists. */
  readonly url: string | null;
  /** The same shape without captions, signed as a download; null when there is none. */
  readonly cleanUrl: string | null;
}

export interface GuestImageView {
  readonly id: ImageFileId;
  readonly width: number;
  readonly height: number;
  /** One per frame (a carousel has five), each signed as a download. */
  readonly urls: readonly string[];
}

export interface GuestDubView {
  /** The dubbing service's code (`hi-IN`). */
  readonly language: string;
  /** The language as a person reads it ("Hindi"). */
  readonly name: string;
  readonly videos: readonly GuestVideoView[];
}

/** Text ready to post, for one platform (`any` when the clip has none per platform). */
export interface GuestPostView {
  readonly platform: "any" | "youtube" | "instagram" | "tiktok" | "linkedin" | "x" | "facebook";
  /** YouTube's title; null elsewhere. */
  readonly title: string | null;
  readonly text: string;
}

export interface GuestClipView {
  readonly id: string;
  readonly title: string;
  readonly durationMs: number | null;
  /**
   * What the page plays: the captioned 9:16 video when there is one (else
   * another shape, else a clean cut). Signed for viewing, not as a download.
   */
  readonly player: {
    readonly shape: VideoShape;
    readonly url: string;
    readonly captioned: boolean;
    /** A still of the clip to show before it plays, when one was made. */
    readonly posterUrl: string | null;
  } | null;
  readonly videos: readonly GuestVideoView[];
  readonly images: readonly GuestImageView[];
  readonly dubs: readonly GuestDubView[];
  readonly hashtags: readonly string[];
  readonly posts: readonly GuestPostView[];
}

export interface GuestPageView {
  /** The video's title. Nothing about the workspace. */
  readonly title: string;
  /** The name the team gave the guest, for the greeting; null when none. */
  readonly guestName: string | null;
  readonly expiresAt: string;
  readonly clips: readonly GuestClipView[];
  /** Shared clips with nothing to download yet (still being made, or waiting for approval). */
  readonly comingSoon: number;
  /** Posts about the whole episode, from its episode text, when it was written. */
  readonly episode: {
    readonly linkedin: string | null;
    readonly xThread: readonly string[];
  } | null;
}
