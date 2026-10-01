import type { VideoShape } from "@montaj/repurpose-contracts";

import { isDubLanguage } from "../dubbing/dub-languages.js";
import { EPISODE_PACK_KIND, parseEpisodePack, type EpisodePack } from "../episode-pack.schema.js";
import { SHAPE_OF_ASPECT } from "../repurpose.constants.js";
import { isRemoved } from "../steering.js";

import type { DubFiles } from "./guest-files.js";
import type { PrismaService } from "../../common/index.js";

/**
 * The reads behind a run's finished files (2026-10-05, shared 2026-10-01): the
 * guest page (`guest-page.service.ts`) and "Download all"
 * (`bundle/run-bundle.service.ts`) offer the same files of the same clips, so
 * they read them the same way. Each read is scoped by workspace (and run)
 * together with the ids it is given.
 */

/** One of a run's clips, as its page lists it. */
export interface RunClipRow {
  readonly id: string;
  readonly title: string;
  readonly copy: unknown;
  readonly images: unknown;
  readonly mezzanineDurationMs: number | null;
  readonly candidate: { readonly state: string; readonly startMs: number };
}

/**
 * A run's clips as its page lists them (a removed moment's clip is not one),
 * in the order their moments come in the video; only `clipIds` when given.
 */
export async function runClipsOf(
  prisma: PrismaService,
  scope: { readonly workspaceId: string; readonly runId: string },
  clipIds?: readonly string[],
): Promise<RunClipRow[]> {
  const rows = await prisma.repurposeClip.findMany({
    where: {
      runId: scope.runId,
      run: { workspaceId: scope.workspaceId },
      ...(clipIds === undefined ? {} : { id: { in: [...clipIds] } }),
    },
    select: {
      id: true,
      title: true,
      copy: true,
      images: true,
      mezzanineDurationMs: true,
      candidate: { select: { state: true, startMs: true } },
    },
  });
  return rows
    .filter((row) => !isRemoved(row.candidate))
    .sort((a, b) => a.candidate.startMs - b.candidate.startMs);
}

/** Media whose file is written: a clip's cut is stored before it is probed. */
const STORED_MEDIA = ["uploaded", "probing", "ready"] as const;

/**
 * The stored primary media of some projects, by project. Pending or failed
 * media, and media whose derived copy was purged, are no file to offer.
 */
export async function primaryMediaOf(
  prisma: PrismaService,
  projectIds: readonly string[],
  options: { readonly readyOnly?: boolean } = {},
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const media = await prisma.mediaAsset.findMany({
    where: {
      projectId: { in: [...projectIds] },
      role: "primary",
      status: { in: options.readyOnly === true ? ["ready"] : [...STORED_MEDIA] },
      derivedPurgedAt: null,
    },
    orderBy: { createdAt: "desc" },
    select: { projectId: true, storageKey: true },
  });
  const byProject = new Map<string, string>();
  for (const row of media) {
    if (row.storageKey !== "" && !byProject.has(row.projectId)) {
      byProject.set(row.projectId, row.storageKey);
    }
  }
  return byProject;
}

/** Each clip's clean cut per shape: its shape project's primary media, while stored. */
export async function cleanCutsOf(
  prisma: PrismaService,
  clipIds: readonly string[],
): Promise<Map<string, Map<VideoShape, string>>> {
  const variants = await prisma.clipVariant.findMany({
    where: { clipId: { in: [...clipIds] } },
    select: { clipId: true, aspect: true, projectId: true },
  });
  const byProject = await primaryMediaOf(
    prisma,
    variants.map((variant) => variant.projectId),
  );
  const byClip = new Map<string, Map<VideoShape, string>>();
  for (const variant of variants) {
    const key = byProject.get(variant.projectId);
    if (key === undefined) continue;
    const shapes = byClip.get(variant.clipId) ?? new Map<VideoShape, string>();
    shapes.set(SHAPE_OF_ASPECT[variant.aspect], key);
    byClip.set(variant.clipId, shapes);
  }
  return byClip;
}

/**
 * The clips' dubbed versions, per clip and language: each shape's newest
 * captioned export and its clean picture. A dub still dubbing, failed or
 * cancelled has nothing to offer; a language dubbed twice offers the newest.
 */
export async function dubFilesOf(
  prisma: PrismaService,
  scope: { readonly workspaceId: string; readonly runId: string },
  clipIds: readonly string[],
): Promise<Map<string, DubFiles[]>> {
  const dubs = await prisma.clipDub.findMany({
    where: {
      runId: scope.runId,
      workspaceId: scope.workspaceId,
      clipId: { in: [...clipIds] },
      status: { in: ["making", "ready"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, clipId: true, languages: true },
  });
  if (dubs.length === 0) return new Map();
  const variants = await prisma.clipDubVariant.findMany({
    where: { dubId: { in: dubs.map((dub) => dub.id) } },
    select: { dubId: true, language: true, aspect: true, projectId: true },
  });
  const projectIds = variants.map((variant) => variant.projectId);
  const [exports, clean] = await Promise.all([
    prisma.export.findMany({
      where: {
        projectId: { in: projectIds },
        workspaceId: scope.workspaceId,
        status: "succeeded",
        kind: "mp4",
        storageKey: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { projectId: true, storageKey: true },
    }),
    primaryMediaOf(prisma, projectIds, { readyOnly: true }),
  ]);
  const newestExport = new Map<string, string>();
  for (const row of exports) {
    if (row.storageKey !== null && !newestExport.has(row.projectId)) {
      newestExport.set(row.projectId, row.storageKey);
    }
  }

  const byClip = new Map<string, DubFiles[]>();
  const taken = new Map<string, Set<string>>();
  for (const dub of dubs) {
    const languagesTaken = taken.get(dub.clipId) ?? new Set<string>();
    taken.set(dub.clipId, languagesTaken);
    for (const language of dub.languages) {
      if (!isDubLanguage(language) || languagesTaken.has(language)) continue;
      const shapes = new Map<
        VideoShape,
        { readonly captionedKey: string | null; readonly cleanKey: string | null }
      >();
      for (const variant of variants) {
        if (variant.dubId !== dub.id || variant.language !== language) continue;
        const captionedKey = newestExport.get(variant.projectId) ?? null;
        const cleanKey = clean.get(variant.projectId) ?? null;
        if (captionedKey === null && cleanKey === null) continue;
        shapes.set(SHAPE_OF_ASPECT[variant.aspect], { captionedKey, cleanKey });
      }
      if (shapes.size === 0) continue;
      languagesTaken.add(language);
      const list = byClip.get(dub.clipId) ?? [];
      list.push({ language, shapes });
      byClip.set(dub.clipId, list);
    }
  }
  return byClip;
}

/** The episode text the run's source got (chapters, descriptions, posts), when it did. */
export async function episodePackOf(
  prisma: PrismaService,
  workspaceId: string,
  sourceProjectId: string,
): Promise<EpisodePack | null> {
  const row = await prisma.llmOutput.findFirst({
    where: { projectId: sourceProjectId, workspaceId, kind: EPISODE_PACK_KIND },
    orderBy: { createdAt: "desc" },
    select: { output: true },
  });
  return row === null ? null : parseEpisodePack(row.output);
}
