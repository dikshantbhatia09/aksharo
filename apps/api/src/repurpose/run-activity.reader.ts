import { Injectable, Logger, Optional } from "@nestjs/common";

import {
  IMAGE_ATTEMPTS,
  clipFolder,
  planClipImages,
  stillsJobKey,
  stillsKeyPrefix,
  storedImagesOf,
  type ShapeVideos,
} from "./clip-images.js";
import { clipFactsOf, clipStateOf, latestClipJobs } from "./clip-state.js";
import { RepurposeClipsService } from "./repurpose-clips.service.js";
import {
  ASPECT_OF_SHAPE,
  FORMATS_MIN_FREE_BYTES,
  FORMAT_CUT_ATTEMPTS,
  FORMAT_SHAPES,
  SHAPE_OF_ASPECT,
  automationOf,
  formatCutKeyPrefix,
} from "./repurpose.constants.js";
import { activityOf } from "./run-activity.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MEDIA_JOB_KEYS } from "../media/media.constants.js";

import type {
  ActivityResult,
  ClipsProgress,
  Finishes,
  ProgressSample,
  RunActivityFacts,
  StepJob,
} from "./run-activity.js";
import type { $Enums, Prisma, RepurposeRun } from "@prisma/client";

/** What the caller already knows about the run as it is shown. */
export interface ShownRun {
  /** The status the view shows (observed while the early stages lag). */
  readonly status: $Enums.RepurposeRunStatus;
  readonly candidateCount: number;
  /** `waitingFor.until`, as ms, while YouTube is refusing this server. */
  readonly sourceBusyUntil: number | null;
}

/** How many of a job's newest progress reports are read for its rate. */
const SAMPLE_LIMIT = 40;

const STEP_JOB_FIELDS = {
  id: true,
  type: true,
  status: true,
  progress: true,
  etaMs: true,
  queuedAt: true,
  startedAt: true,
  attemptId: true,
  params: true,
} as const satisfies Prisma.JobSelect;

type StepJobRow = Prisma.JobGetPayload<{ select: typeof STEP_JOB_FIELDS }>;

function paramOf(job: StepJobRow, key: string): unknown {
  const params = job.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  // eslint-disable-next-line security/detect-object-injection -- `key` is one of this file's literals
  return (params as Record<string, unknown>)[key];
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CLIP_FIELDS = {
  id: true,
  candidateId: true,
  mezzanineKey: true,
  mezzanineDurationMs: true,
  sourceStartMs: true,
  sourceEndMs: true,
  updatedAt: true,
  images: true,
  variants: {
    select: {
      aspect: true,
      status: true,
      profileVersion: true,
      latestExport: {
        select: {
          id: true,
          status: true,
          storageKey: true,
          job: { select: { startedAt: true, finishedAt: true } },
        },
      },
      project: {
        select: {
          mediaAssets: {
            where: { role: "primary" },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              role: true,
              status: true,
              failureReason: true,
              storageKey: true,
              createdAt: true,
            },
          },
        },
      },
    },
  },
} as const satisfies Prisma.RepurposeClipSelect;

type ClipRow = Prisma.RepurposeClipGetPayload<{ select: typeof CLIP_FIELDS }>;
type VariantRow = ClipRow["variants"][number];

/** A shape's captioned video exists: its render succeeded and its file is kept. */
function made(variant: VariantRow): boolean {
  const render = variant.latestExport;
  return (
    variant.status === "ready" &&
    render !== null &&
    render.status === "succeeded" &&
    render.storageKey !== null
  );
}

/** Made, or failed for good (`RepurposeClipsService.shapeVideosOf`'s "settled"). */
function settled(variant: VariantRow): boolean {
  return variant.status === "failed" || made(variant);
}

/** Where a finished render's time goes, for a throughput. */
function addRender(finishes: { at: number[]; durationsMs: number[] }, variant: VariantRow): void {
  const job = variant.latestExport?.job;
  if (job?.finishedAt === null || job?.finishedAt === undefined) return;
  finishes.at.push(job.finishedAt.getTime());
  if (job.startedAt !== null) {
    finishes.durationsMs.push(job.finishedAt.getTime() - job.startedAt.getTime());
  }
}

/**
 * Reads, from durable state, what `run-activity.ts` decides from: the current
 * step's newest job with its progress reports and its place in line, or the
 * run's clips and everything made from them. Only the step the run is on is
 * read, so a run page's poll costs a handful of queries.
 *
 * The clip counts follow the same rules as the clip list the page shows
 * (`clipStateOf`, and `RepurposeClipsService.shapeVideosOf` / `imagesOf` for
 * the shapes and images, through the same pure helpers), so the step and the
 * cards below it cannot disagree.
 */
@Injectable()
export class RunActivityReader {
  private readonly logger = new Logger(RunActivityReader.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Reads whether a queued job is held for disk; absent in unit harnesses. */
    @Optional() private readonly jobs?: JobsService,
    /** The API volume's free space, which holds the other shapes back. */
    @Optional() private readonly clips?: RepurposeClipsService,
  ) {}

  /**
   * The activity and bar for `run`. Never throws: a read that cannot be made
   * leaves the view without an activity and with its status's bar, which is
   * what it had before any of this existed.
   */
  async forRun(
    run: RepurposeRun,
    shown: ShownRun,
    now: number = Date.now(),
  ): Promise<ActivityResult> {
    try {
      return activityOf(await this.facts(run, shown, now));
    } catch (error) {
      this.logger.warn({ runId: run.id, err: error }, "could not read the run's activity");
      return { activity: null, progress: null };
    }
  }

  async facts(
    run: RepurposeRun,
    shown: ShownRun,
    now: number = Date.now(),
  ): Promise<RunActivityFacts> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, uploadedAt: true },
    });
    const base: RunActivityFacts = {
      now,
      status: shown.status,
      automation: automationOf(run),
      sourceKind: run.sourceKind,
      candidateCount: shown.candidateCount,
      sourceBusyUntil: shown.sourceBusyUntil,
      media: media === null ? null : { status: media.status, arrived: media.uploadedAt !== null },
      download: null,
      preparation: null,
      transcription: null,
      discovery: null,
      clips: null,
    };

    switch (shown.status) {
      case "draft":
      case "acquiring": {
        if (run.sourceKind === "upload") return base;
        const found = await this.stepJob(
          {
            workspaceId: run.workspaceId,
            type: "media.acquire",
            jobKey: { startsWith: `media.acquire:${run.id}:` },
          },
          media?.id,
        );
        return { ...base, download: found?.job ?? null };
      }
      case "preparing_media": {
        if (media === null) return base;
        const found = await this.stepJob({
          workspaceId: run.workspaceId,
          projectId: run.sourceProjectId,
          type: { in: ["media.probe", "media.proxy"] },
          jobKey: { in: [MEDIA_JOB_KEYS.probe(media.id), MEDIA_JOB_KEYS.proxy(media.id)] },
        });
        return {
          ...base,
          preparation: found === null ? null : preparationOf(found.job, found.type),
        };
      }
      case "transcribing": {
        const found = await this.stepJob(
          { projectId: run.sourceProjectId, type: "ai.transcribe" },
          media?.id,
        );
        return { ...base, transcription: found?.job ?? null };
      }
      case "analyzing": {
        const found = await this.stepJob({
          workspaceId: run.workspaceId,
          type: "ai.highlights",
          jobKey: { startsWith: `ai.highlights:${run.id}:` },
        });
        return { ...base, discovery: found?.job ?? null };
      }
      case "candidates_ready":
      case "materializing":
      case "rendering":
      case "review_ready":
      case "changes_requested":
      case "approved":
        return { ...base, clips: await this.clipsProgress(run, now) };
      default:
        return base;
    }
  }

  /**
   * The newest job matching `where` — the one fetching into `mediaId`, when
   * one is named, as the reconciler reads it — with its progress reports,
   * oldest first, and while it is queued its place in line and whether the
   * media machine is holding it for disk.
   */
  private async stepJob(
    where: Prisma.JobWhereInput,
    mediaId?: string,
  ): Promise<{ readonly job: StepJob; readonly type: string } | null> {
    const rows = await this.prisma.job.findMany({
      where,
      orderBy: { queuedAt: "desc" },
      take: 10,
      select: STEP_JOB_FIELDS,
    });
    const row =
      (mediaId === undefined
        ? undefined
        : rows.find((job) => paramOf(job, "mediaId") === mediaId)) ?? rows[0];
    if (row === undefined) return null;

    const events = await this.prisma.jobEvent.findMany({
      where: { jobId: row.id, data: { path: ["event"], equals: "job.progress" } },
      orderBy: { at: "desc" },
      take: SAMPLE_LIMIT,
      select: { at: true, data: true },
    });
    const samples: ProgressSample[] = [];
    for (const event of [...events].reverse()) {
      const data =
        typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
      const progress = numberOf(data["progress"]);
      if (progress === undefined) continue;
      const bytesDone = numberOf(data["bytesDone"]);
      const bytesTotal = numberOf(data["bytesTotal"]);
      samples.push({
        at: event.at.getTime(),
        progress,
        ...(bytesDone === undefined ? {} : { bytesDone }),
        ...(bytesTotal === undefined ? {} : { bytesTotal }),
      });
    }

    const queued = row.status === "queued";
    const ahead = queued
      ? await this.prisma.job.count({
          // Every workspace's: the line is the machine's, not the account's.
          where: { type: row.type, status: "queued", queuedAt: { lt: row.queuedAt } },
        })
      : null;
    const heldForDisk =
      queued && this.jobs !== undefined ? (await this.jobs.diskHeldSince(row)) !== null : false;

    return {
      job: {
        status: row.status,
        progress: row.progress,
        etaMs: row.etaMs,
        samples,
        ahead,
        heldForDisk,
      },
      type: row.type,
    };
  }

  /**
   * A run's clips, counted for the activity and for the run notifications:
   * each clip's state, and on Autopilot its captioned video, its other
   * shapes and its images, with when each finished for a throughput.
   */
  async clipsProgress(run: RepurposeRun, now: number = Date.now()): Promise<ClipsProgress> {
    const rows = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      select: CLIP_FIELDS,
    });
    const latest = await latestClipJobs(
      this.prisma,
      run.workspaceId,
      rows.map((row) => row.candidateId),
    );

    let ready = 0;
    let cutting = 0;
    let waiting = 0;
    let failed = 0;
    let usable = 0;
    const readyRows: ClipRow[] = [];
    const cuts = { at: [] as number[], durationsMs: [] as number[] };
    for (const row of rows) {
      const job = latest.get(row.candidateId);
      const { state } = clipStateOf(clipFactsOf(row), job, { now });
      if (state === "ready") {
        ready += 1;
        readyRows.push(row);
        const media = row.variants.find((variant) => variant.aspect === "r9x16")?.project
          .mediaAssets[0];
        if (media?.status === "ready") usable += 1;
      } else if (state === "cutting") cutting += 1;
      else if (state === "waiting") waiting += 1;
      else failed += 1;
      if (job?.status === "succeeded" && job.finishedAt !== null && job.finishedAt !== undefined) {
        cuts.at.push(job.finishedAt.getTime());
        if (job.startedAt !== null && job.startedAt !== undefined) {
          cuts.durationsMs.push(job.finishedAt.getTime() - job.startedAt.getTime());
        }
      }
    }

    const empty: Finishes = { at: [], durationsMs: [] };
    const progress: ClipsProgress = {
      total: rows.length,
      ready,
      cutting,
      waiting,
      failed,
      usable,
      captioned: { ready: 0, settled: 0 },
      formats: { total: 0, settled: 0 },
      images: { total: 0, settled: 0 },
      finished: { cuts, captioned: empty, formats: empty, images: empty },
      lowDisk: false,
    };
    if (automationOf(run) !== "auto" || readyRows.length === 0) return progress;
    return this.autopilotProgress(run, progress, readyRows);
  }

  /** The captioned videos, the other shapes and the images of an Autopilot run's ready clips. */
  private async autopilotProgress(
    run: RepurposeRun,
    progress: ClipsProgress,
    readyRows: readonly ClipRow[],
  ): Promise<ClipsProgress> {
    const [formatCuts, stills] = await Promise.all([
      this.prisma.job.findMany({
        where: {
          workspaceId: run.workspaceId,
          type: "media.clip",
          OR: readyRows.map((row) => ({
            jobKey: { startsWith: `media.clip.format:${row.candidateId}:` },
          })),
        },
        select: { jobKey: true, status: true },
      }),
      this.prisma.job.findMany({
        where: {
          workspaceId: run.workspaceId,
          type: "media.stills",
          OR: readyRows.map((row) => ({ jobKey: { startsWith: stillsKeyPrefix(row.id) } })),
        },
        select: { jobKey: true, status: true, startedAt: true, finishedAt: true },
      }),
    ]);

    const captionedFinishes = { at: [] as number[], durationsMs: [] as number[] };
    const formatFinishes = { at: [] as number[], durationsMs: [] as number[] };
    const imageFinishes = { at: [] as number[], durationsMs: [] as number[] };
    let captionedReady = 0;
    let captionedSettled = 0;
    let formatsSettled = 0;
    let imagesSettled = 0;

    for (const row of readyRows) {
      const vertical = row.variants.find((variant) => variant.aspect === "r9x16");
      if (vertical !== undefined && made(vertical)) {
        captionedReady += 1;
        addRender(captionedFinishes, vertical);
      }
      if (vertical !== undefined && settled(vertical)) captionedSettled += 1;

      const abandoned = new Set<(typeof FORMAT_SHAPES)[number]>();
      for (const shape of FORMAT_SHAPES) {
        // eslint-disable-next-line security/detect-object-injection -- a FORMAT_SHAPES literal
        const variant = row.variants.find((each) => each.aspect === ASPECT_OF_SHAPE[shape]);
        if (variant !== undefined) {
          if (settled(variant)) formatsSettled += 1;
          if (made(variant)) addRender(formatFinishes, variant);
          continue;
        }
        const prefix = formatCutKeyPrefix(row.candidateId, shape);
        const ended = formatCuts.filter(
          (job) =>
            job.jobKey.startsWith(prefix) &&
            (job.status === "failed" || job.status === "cancelled"),
        ).length;
        if (ended >= FORMAT_CUT_ATTEMPTS) {
          abandoned.add(shape);
          formatsSettled += 1;
        }
      }

      // The images' own rule (`RepurposeClipsService.imagesOf`), on the same plan.
      if (row.mezzanineKey === null) continue;
      const plan = planClipImages({
        videos: row.variants.map((variant) => shapeVideosOf(variant)),
        abandoned,
        folder: clipFolder(row.mezzanineKey),
        durationMs: row.mezzanineDurationMs ?? row.sourceEndMs - row.sourceStartMs,
      });
      const ofClip = stills.filter((job) => job.jobKey.startsWith(stillsKeyPrefix(row.id)));
      for (const job of ofClip) {
        if (job.status !== "succeeded" || job.finishedAt === null) continue;
        imageFinishes.at.push(job.finishedAt.getTime());
        if (job.startedAt !== null) {
          imageFinishes.durationsMs.push(job.finishedAt.getTime() - job.startedAt.getTime());
        }
      }
      if (plan.kind === "none") {
        imagesSettled += 1;
      } else if (plan.kind === "ready") {
        const key = stillsJobKey(row.id, plan.fingerprint);
        const failedSets = ofClip.filter(
          (job) => job.jobKey === key && (job.status === "failed" || job.status === "cancelled"),
        ).length;
        if (
          storedImagesOf(row.images)?.fingerprint === plan.fingerprint ||
          failedSets >= IMAGE_ATTEMPTS
        ) {
          imagesSettled += 1;
        }
      }
    }

    const formatsTotal = readyRows.length * FORMAT_SHAPES.length;
    const unfinished = formatsSettled < formatsTotal || imagesSettled < readyRows.length;
    const lowDisk =
      unfinished && this.clips !== undefined
        ? (await this.clips.freeBytes()) < FORMATS_MIN_FREE_BYTES
        : false;

    return {
      ...progress,
      captioned: { ready: captionedReady, settled: captionedSettled },
      formats: { total: formatsTotal, settled: formatsSettled },
      images: { total: readyRows.length, settled: imagesSettled },
      finished: {
        cuts: progress.finished.cuts,
        captioned: captionedFinishes,
        formats: formatFinishes,
        images: imageFinishes,
      },
      lowDisk,
    };
  }
}

/** One shape as the image plan reads it (`RepurposeClipsService.shapeVideosOf`). */
function shapeVideosOf(variant: VariantRow): ShapeVideos {
  const render = variant.latestExport;
  const clean = variant.project.mediaAssets[0];
  return {
    shape: SHAPE_OF_ASPECT[variant.aspect],
    settled: settled(variant),
    captioned:
      made(variant) && render !== null && render.storageKey !== null
        ? { exportId: render.id, key: render.storageKey }
        : null,
    clean:
      clean === undefined || clean.status !== "ready" || clean.storageKey === ""
        ? null
        : { mediaId: clean.id, key: clean.storageKey },
  };
}

/**
 * The media's preparation as one step: its probe is the first tenth, its
 * proxy (the encode) the rest, so the bar does not fall back to nothing when
 * the probe hands over to the proxy.
 */
function preparationOf(job: StepJob, type: string): StepJob {
  const probe = type === "media.probe";
  const scale = (progress: number): number => (probe ? progress * 0.1 : 10 + progress * 0.9);
  return {
    ...job,
    progress: scale(job.progress),
    samples: job.samples.map((sample) => ({ ...sample, progress: scale(sample.progress) })),
  };
}
