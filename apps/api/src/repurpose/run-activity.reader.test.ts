import { describe, expect, it } from "vitest";

import { clipFolder, planClipImages, stillsJobKey } from "./clip-images.js";
import { RunActivityReader } from "./run-activity.reader.js";

import type { RepurposeClipsService } from "./repurpose-clips.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { RepurposeRun } from "@prisma/client";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const RUN = "01JRUN0000000000000000000A";
const WS = "01JWS00000000000000000000A";
const PROJECT = "01JPROJ000000000000000000A";
const MEDIA = "01JMEDIA00000000000000000A";
const GIB = 1024 ** 3;

function run(overrides: Partial<RepurposeRun> = {}): RepurposeRun {
  return {
    id: RUN,
    workspaceId: WS,
    sourceProjectId: PROJECT,
    sourceKind: "youtube_url",
    config: { automation: "auto" },
    status: "acquiring",
    ...overrides,
  } as RepurposeRun;
}

interface Calls {
  counts: unknown[];
  jobQueries: unknown[];
}

/**
 * Just the reads the reader makes, answered from fixtures by what they ask
 * for — the query shapes are the reader's own, so this checks it asks for the
 * right rows and puts them together right.
 */
function fakePrisma(fixtures: {
  readonly media?: unknown;
  readonly jobsByType?: Record<string, readonly Record<string, unknown>[]>;
  readonly events?: readonly { at: Date; data: unknown }[];
  readonly ahead?: number;
  readonly clips?: readonly unknown[];
}): { prisma: PrismaService; calls: Calls } {
  const calls: Calls = { counts: [], jobQueries: [] };
  const byType = new Map(Object.entries(fixtures.jobsByType ?? {}));
  const prisma = {
    mediaAsset: { findFirst: async () => fixtures.media ?? null },
    job: {
      findMany: async (args: { where: { type?: unknown } }) => {
        calls.jobQueries.push(args.where);
        const type = args.where.type;
        if (typeof type === "string") return [...(byType.get(type) ?? [])];
        const types = (type as { in?: string[] } | undefined)?.in ?? [];
        return types.flatMap((each) => byType.get(each) ?? []);
      },
      count: async (args: unknown) => {
        calls.counts.push(args);
        return fixtures.ahead ?? 0;
      },
    },
    jobEvent: { findMany: async () => [...(fixtures.events ?? [])] },
    repurposeClip: { findMany: async () => [...(fixtures.clips ?? [])] },
  } as unknown as PrismaService;
  return { prisma, calls };
}

describe("RunActivityReader: the step a run is on", () => {
  it("reads the download fetching into the newest media, with its reports oldest first", async () => {
    const { prisma } = fakePrisma({
      media: { id: MEDIA, status: "pending", uploadedAt: null },
      jobsByType: {
        "media.acquire": [
          // The newest row is a refetch into another media row; the one that
          // fetches into the current media is the one that counts.
          {
            id: "01JOTHER00000000000000000A",
            type: "media.acquire",
            status: "failed",
            progress: 12,
            etaMs: null,
            queuedAt: new Date(NOW - 60_000),
            startedAt: null,
            attemptId: null,
            params: { mediaId: "01JOLDMEDIA000000000000000" },
          },
          {
            id: "01JACQUIRE000000000000000A",
            type: "media.acquire",
            status: "running",
            progress: 48,
            etaMs: null,
            queuedAt: new Date(NOW - 600_000),
            startedAt: new Date(NOW - 590_000),
            attemptId: "01JATTEMPT00000000000000AA",
            params: { mediaId: MEDIA },
          },
        ],
      },
      // Newest first, as the query orders them.
      events: [
        {
          at: new Date(NOW - 5_000),
          data: {
            event: "job.progress",
            progress: 48,
            bytesDone: Math.round(3.2 * GIB),
            bytesTotal: 5 * GIB,
          },
        },
        {
          at: new Date(NOW - 125_000),
          data: {
            event: "job.progress",
            progress: 30,
            bytesDone: Math.round(1.7 * GIB),
            bytesTotal: 5 * GIB,
          },
        },
        { at: new Date(NOW - 600_000), data: { event: "job.progress", progress: 0 } },
      ],
    });
    const reader = new RunActivityReader(prisma);
    const result = await reader.forRun(
      run(),
      { status: "acquiring", candidateCount: 0, sourceBusyUntil: null },
      NOW,
    );
    expect(result.activity).toMatchObject({
      step: "downloading",
      detail: "3.2 of 5.0 GB",
      percent: 64,
    });
    // 1.5 GB in two minutes, 1.8 GB to go: about 144 s from a report 5 s old.
    expect(result.activity?.etaSeconds).toBeGreaterThan(130);
    expect(result.activity?.etaSeconds).toBeLessThan(150);
  });

  it("counts the line across every workspace for a queued step, and asks about disk", async () => {
    const queued = {
      id: "01JTRANSCRIBE0000000000000",
      type: "ai.transcribe",
      status: "queued",
      progress: 0,
      etaMs: null,
      queuedAt: new Date(NOW - 30_000),
      startedAt: null,
      attemptId: "01JATTEMPT00000000000000AA",
      params: { mediaId: MEDIA },
    };
    const { prisma, calls } = fakePrisma({
      media: { id: MEDIA, status: "ready", uploadedAt: new Date(NOW - 900_000) },
      jobsByType: { "ai.transcribe": [queued] },
      ahead: 3,
    });
    const asked: unknown[] = [];
    const jobs = {
      diskHeldSince: async (job: unknown) => {
        asked.push(job);
        return null;
      },
    } as unknown as JobsService;
    const result = await new RunActivityReader(prisma, jobs).forRun(
      run(),
      { status: "transcribing", candidateCount: 0, sourceBusyUntil: null },
      NOW,
    );
    expect(result.activity).toEqual({
      step: "queued",
      label: "Waiting for a free spot",
      detail: "3 ahead of you",
      queuePosition: 3,
    });
    expect(calls.counts).toEqual([
      { where: { type: "ai.transcribe", status: "queued", queuedAt: { lt: queued.queuedAt } } },
    ]);
    expect(asked).toHaveLength(1);
  });

  it("never lets a read it cannot make break the run's view", async () => {
    const prisma = {
      mediaAsset: {
        findFirst: async () => {
          throw new Error("database blinked");
        },
      },
    } as unknown as PrismaService;
    const result = await new RunActivityReader(prisma).forRun(
      run(),
      { status: "acquiring", candidateCount: 0, sourceBusyUntil: null },
      NOW,
    );
    expect(result).toEqual({ activity: null, progress: null });
  });
});

describe("RunActivityReader: an Autopilot run's clips", () => {
  const made = (aspect: string, project: string, exportId: string) => ({
    aspect,
    status: "ready",
    profileVersion: "3",
    latestExport: {
      id: exportId,
      status: "succeeded",
      storageKey: `ws/x/exports/${exportId}.mp4`,
      job: { startedAt: new Date(NOW - 200_000), finishedAt: new Date(NOW - 100_000) },
    },
    project: {
      mediaAssets: [
        {
          id: `${project}-media`,
          role: "primary",
          status: "ready",
          failureReason: null,
          storageKey: `ws/x/p/${project}/raw.mp4`,
          createdAt: new Date(NOW - 300_000),
        },
      ],
    },
  });

  function clipRow(id: string, candidateId: string, variants: unknown[], images: unknown = {}) {
    return {
      id,
      candidateId,
      mezzanineKey: `ws/x/clips/${id}/master.mp4`,
      mezzanineDurationMs: 30_000,
      sourceStartMs: 0,
      sourceEndMs: 30_000,
      updatedAt: new Date(NOW - 500_000),
      images,
      variants,
    };
  }

  it("counts each clip's captioned video, other sizes and images the way the clip list does", async () => {
    // Clip A: every size made, and its image set stored.
    const allSizes = [
      made("r9x16", "a916", "01JEXPORTA916000000000000A"),
      made("r4x5", "a45", "01JEXPORTA45000000000000AA"),
      made("r1x1", "a11", "01JEXPORTA11000000000000AA"),
      made("r16x9", "a169", "01JEXPORTA169000000000000A"),
    ];
    const plan = planClipImages({
      videos: allSizes.map((variant) => ({
        shape: { r9x16: "9:16", r4x5: "4:5", r1x1: "1:1", r16x9: "16:9" }[variant.aspect] as
          "9:16" | "4:5" | "1:1" | "16:9",
        settled: true,
        captioned: { exportId: variant.latestExport.id, key: variant.latestExport.storageKey },
        clean: {
          mediaId: variant.project.mediaAssets[0]?.id ?? "",
          key: variant.project.mediaAssets[0]?.storageKey ?? "",
        },
      })),
      abandoned: new Set(),
      folder: clipFolder("ws/x/clips/01JCLIPA000000000000000000/master.mp4"),
      durationMs: 30_000,
    });
    if (plan.kind !== "ready") throw new Error("expected a ready image plan");
    const clipA = clipRow("01JCLIPA000000000000000000", "01JCANDA000000000000000000", allSizes, {
      fingerprint: plan.fingerprint,
      images: [],
    });
    // Clip B: its 9:16 made, its other sizes not cut yet, so its images wait.
    const clipB = clipRow("01JCLIPB000000000000000000", "01JCANDB000000000000000000", [
      made("r9x16", "b916", "01JEXPORTB916000000000000A"),
    ]);

    const cut = (candidate: string) => ({
      id: `${candidate}-job`,
      jobKey: `media.clip:${candidate}:0-30000:3`,
      status: "succeeded",
      error: null,
      queuedAt: new Date(NOW - 700_000),
      startedAt: new Date(NOW - 690_000),
      finishedAt: new Date(NOW - 640_000),
      maxQueueWaitMs: null,
    });
    const { prisma } = fakePrisma({
      clips: [clipA, clipB],
      jobsByType: {
        "media.clip": [cut("01JCANDA000000000000000000"), cut("01JCANDB000000000000000000")],
        "media.stills": [
          {
            jobKey: stillsJobKey("01JCLIPA000000000000000000", plan.fingerprint),
            status: "succeeded",
            startedAt: new Date(NOW - 60_000),
            finishedAt: new Date(NOW - 30_000),
          },
        ],
      },
    });
    const clipsService = { freeBytes: async () => 100 * GIB } as unknown as RepurposeClipsService;
    const progress = await new RunActivityReader(prisma, undefined, clipsService).clipsProgress(
      run({ status: "review_ready" }),
      NOW,
    );

    expect(progress).toMatchObject({
      total: 2,
      ready: 2,
      usable: 2,
      captioned: { ready: 2, settled: 2 },
      formats: { total: 6, settled: 3 },
      images: { total: 2, settled: 1 },
      lowDisk: false,
    });
    expect(progress.finished.images.at).toEqual([NOW - 30_000]);
    expect(progress.finished.cuts.at).toHaveLength(2);
  });
});
