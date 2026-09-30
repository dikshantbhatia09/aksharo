import { readLatest } from "./metrics.js";
import { isPostPlatform } from "./post-links.js";
import { SHAPE_OF_ASPECT } from "../repurpose.constants.js";

import type { ClipFacts, PostFacts } from "./what-works.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { Prisma } from "@prisma/client";

/**
 * A workspace's posts as "What works" and the steering signal read them
 * (2026-10-05): each post's newest numbers, with the facts about its clip the
 * comparisons are made on - read from the clip, its run and the shape posted,
 * never from anyone's profile.
 */

/** Where a workspace's post times are read when it has never scheduled a post: India. */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

const POST_SELECT = {
  id: true,
  platform: true,
  url: true,
  latest: true,
  postedAt: true,
  createdAt: true,
  language: true,
  aspect: true,
  clip: {
    select: {
      id: true,
      runId: true,
      title: true,
      copy: true,
      sourceStartMs: true,
      sourceEndMs: true,
      candidate: { select: { transcriptExcerpt: true } },
      variants: { select: { aspect: true, layout: true } },
    },
  },
  run: { select: { config: true } },
} as const satisfies Prisma.ClipPostSelect;

type PostRow = Prisma.ClipPostGetPayload<{ select: typeof POST_SELECT }>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The language a post's words are in: its dub's, else the run's captions', else the run's. */
function languageOf(row: PostRow): string | null {
  if (row.language !== null) return row.language;
  const config = record(row.run.config);
  const caption = text(record(config["caption"])["outputLanguage"]);
  if (caption !== null && caption !== "same" && caption !== "auto") return caption;
  const spoken = text(config["sourceLanguage"]);
  return spoken === "auto" ? null : spoken;
}

export function clipFactsOf(row: PostRow): ClipFacts {
  const copy = record(row.clip.copy);
  return {
    clipId: row.clip.id,
    runId: row.clip.runId,
    title: text(copy["title"]) ?? row.clip.title,
    hook: text(copy["hook"]),
    excerpt: row.clip.candidate.transcriptExcerpt,
    durationMs: Math.max(0, row.clip.sourceEndMs - row.clip.sourceStartMs),
  };
}

export function postFactsOf(row: PostRow): PostFacts | null {
  if (!isPostPlatform(row.platform)) return null;
  const latest = readLatest(row.latest);
  const variant = row.clip.variants.find((entry) => entry.aspect === row.aspect);
  return {
    postId: row.id,
    clip: clipFactsOf(row),
    platform: row.platform,
    url: row.url,
    views: latest.views?.value ?? null,
    likes: latest.likes?.value ?? null,
    comments: latest.comments?.value ?? null,
    shares: latest.shares?.value ?? null,
    viewsMeasured: latest.views === undefined ? null : latest.views.source !== "person",
    postedAt: row.postedAt,
    at: row.postedAt ?? row.createdAt,
    layout: variant?.layout ?? null,
    language: languageOf(row),
  };
}

/**
 * The workspace's posts that went out since `since` (or, with no known time,
 * were recorded since then), newest first, at most `limit`.
 */
export async function loadPostFacts(
  prisma: Pick<PrismaService, "clipPost">,
  workspaceId: string,
  since: Date,
  limit: number,
): Promise<PostFacts[]> {
  const rows = await prisma.clipPost.findMany({
    where: {
      workspaceId,
      OR: [{ postedAt: { gte: since } }, { postedAt: null, createdAt: { gte: since } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: POST_SELECT,
  });
  return rows.flatMap((row) => {
    const facts = postFactsOf(row);
    return facts === null ? [] : [facts];
  });
}

/** Whether `zone` is a time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    return Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** The zone the workspace last scheduled a post in, else {@link DEFAULT_TIME_ZONE}. */
export async function timeZoneFor(
  prisma: Pick<PrismaService, "publishBatch">,
  workspaceId: string,
): Promise<string> {
  const batch = await prisma.publishBatch.findFirst({
    where: { workspaceId },
    orderBy: { confirmedAt: "desc" },
    select: { timezone: true },
  });
  const zone = batch?.timezone ?? "";
  return zone !== "" && zone !== "UTC" && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
}

/** `9:16` for `r9x16`. */
export function shapeOf(aspect: keyof typeof SHAPE_OF_ASPECT): string {
  // eslint-disable-next-line security/detect-object-injection -- a closed enum key
  return SHAPE_OF_ASPECT[aspect];
}
