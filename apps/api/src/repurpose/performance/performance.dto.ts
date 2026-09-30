import { z } from "zod";

import { MAX_COUNT } from "./metrics.js";
import { DEFAULT_WHAT_WORKS_DAYS, WHAT_WORKS_DAYS } from "./performance.constants.js";
import { MAX_LINK_CHARS } from "./post-links.js";
import { zodDto } from "../../common/index.js";

import type { MetricSource } from "./metrics.js";
import type { PostPlatform } from "./post-links.js";
import type { DimensionView, FindingView, PlatformView, TopClipView } from "./what-works.js";

/**
 * Learn what works (2026-10-05): request bodies and answers.
 *
 * Bodies are strict about shape and loose about meaning: a link to a profile,
 * a shape the clip was not made in, numbers with none in them are refused by
 * the service with a `performance/*` code and a sentence, not a Zod issue list.
 */

const SHAPES = ["9:16", "4:5", "1:1", "16:9"] as const;

/** `POST /repurpose/runs/{runId}/clips/{clipId}/performance/posts`: "I posted this". */
export const addPostSchema = z
  .object({
    /** The post's link, as copied from the platform. */
    url: z.string().trim().min(1).max(MAX_LINK_CHARS),
    /** The shape that was posted; 9:16 when left out. */
    shape: z.enum(SHAPES).optional(),
    /** A dubbed version's language (one of the clip's dubs); the clip's own words when left out. */
    language: z.string().trim().min(2).max(64).optional(),
    /** When it went out: a date, or a date and time with its offset. */
    postedAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  })
  .strict();
export class AddPostDto extends zodDto(addPostSchema) {}
export type AddPostInput = z.infer<typeof addPostSchema>;

const count = z.int().min(0).max(MAX_COUNT);

/** `POST /repurpose/runs/{runId}/performance/posts/{postId}/numbers`: numbers read off the app. */
export const enterNumbersSchema = z
  .object({
    views: count.optional(),
    likes: count.optional(),
    comments: count.optional(),
    shares: count.optional(),
  })
  .strict();
export class EnterNumbersDto extends zodDto(enterNumbersSchema) {}
export type EnterNumbersInput = z.infer<typeof enterNumbersSchema>;

/** `GET /repurpose/performance/what-works?days=`. */
export const whatWorksQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine((days) => (WHAT_WORKS_DAYS as readonly number[]).includes(days), {
        message: `One of ${WHAT_WORKS_DAYS.join(", ")}.`,
      })
      .default(DEFAULT_WHAT_WORKS_DAYS),
  })
  .strict();
export class WhatWorksQueryDto extends zodDto(whatWorksQuerySchema) {}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface MetricView {
  readonly value: number;
  readonly source: MetricSource;
  /** Read by Aksharo (Postiz, the YouTube page), not typed in by a person. */
  readonly measured: boolean;
  /** When it was read or typed. */
  readonly at: string;
}

/**
 * How the post's numbers are kept up to date: `reading` (read by itself on a
 * schedule), `done` (its first month is read), `stopped` (reading gave up;
 * `note` says why), or `manual` (Aksharo cannot read this platform's numbers:
 * they are typed in).
 */
export type ReadingState = "reading" | "done" | "stopped" | "manual";

export interface ClipPostView {
  readonly id: string;
  readonly runId: string;
  readonly clipId: string;
  readonly platform: PostPlatform;
  /** The platform's name, as a person says it. */
  readonly platformLabel: string;
  readonly shape: string;
  /** A dubbed version's language; null for the clip's own words. */
  readonly language: string | null;
  readonly source: "postiz" | "link";
  readonly url: string | null;
  readonly postedAt: string | null;
  readonly numbers: {
    readonly views: MetricView | null;
    readonly likes: MetricView | null;
    readonly comments: MetricView | null;
    readonly shares: MetricView | null;
  };
  /** Likes, comments and shares per view; null under 100 views or without them. */
  readonly engagementRate: number | null;
  readonly reading: {
    readonly state: ReadingState;
    readonly nextAt: string | null;
    /** One sentence, when the state needs explaining. */
    readonly note: string | null;
  };
  /** A pasted link can be removed; a post made through Postiz is followed from there. */
  readonly canRemove: boolean;
  readonly createdAt: string;
}

export interface RunPerformanceView {
  readonly runId: string;
  /** The feature is on for this workspace: the page shows the panel at all. */
  readonly enabled: boolean;
  readonly posts: readonly ClipPostView[];
  /** Per clip, what "I posted this" may say was posted: its shapes and dubbed languages. */
  readonly clips: readonly {
    readonly clipId: string;
    readonly shapes: readonly string[];
    readonly languages: readonly string[];
  }[];
}

export interface WhatWorksView {
  readonly enabled: true;
  readonly days: number;
  /** The zone post times are read in. */
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly posts: number;
    readonly withViews: number;
    readonly measured: number;
    readonly entered: number;
    readonly clips: number;
  };
  readonly enough: boolean;
  /** The bars every finding clears, so the page can say them. */
  readonly thresholds: {
    readonly minPosts: number;
    readonly minGroup: number;
    readonly clearLift: number;
    readonly steeringMinPosts: number;
  };
  readonly platforms: readonly PlatformView[];
  readonly topByViews: readonly TopClipView[];
  readonly topByEngagement: readonly TopClipView[];
  readonly dimensions: readonly DimensionView[];
  readonly findings: readonly FindingView[];
  /** What the next runs' picks lean toward, from a year of posts; null while they say nothing. */
  readonly steering: { readonly basis: number; readonly lines: readonly string[] } | null;
}
