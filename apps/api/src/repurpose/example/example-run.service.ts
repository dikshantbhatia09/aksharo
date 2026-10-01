import { Injectable, Logger } from "@nestjs/common";

import { demoRunIdFrom } from "@montaj/config";
import { ClipCopySchema } from "@montaj/repurpose-contracts";

import { PrismaService } from "../../common/index.js";
import { RepurposeClipsService } from "../repurpose-clips.service.js";
import { automationOf } from "../repurpose.constants.js";
import { cleanSourceTitle } from "../repurpose.projection.js";
import { runTranscriptLines } from "../results/run-results.service.js";
import { isRemoved } from "../steering.js";

import type {
  CaptionedClipView,
  ClipImagesView,
  RepurposeClipItemView,
} from "../repurpose-clips.service.js";
import type { TranscriptLine } from "../results/run-results.service.js";
import type { ClipCandidate, RepurposeRun } from "@prisma/client";

/**
 * How long one answer is served before it is read again. Short enough that the
 * owner swapping `DEMO_RUN_ID` (or a clip being made again) shows within a
 * minute; long enough that a burst of new sign-ups costs one read, not one per
 * person. Far inside every URL's own life (an hour: `CAPTIONED_URL_TTL_SECONDS`,
 * `IMAGE_URL_TTL_SECONDS`), so a cached answer never hands out a dead link.
 */
export const EXAMPLE_CACHE_MS = 60_000;

/** The shortest life a signed URL in this answer has (the clips' own: one hour). */
const URL_TTL_MS = 60 * 60 * 1000;

/** The example is off, or the run it names cannot be shown: the product says nothing. */
export interface ExampleRunUnavailable {
  readonly available: false;
}

/** One line of a clip's words, on the original video's clock. */
export interface ExampleTranscript {
  readonly offsetMs: number;
  readonly lines: readonly TranscriptLine[];
}

/** A moment, as much of it as the results page reads, and nothing of who made it. */
export interface ExampleCandidate {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly rank: number | null;
  readonly potentialScore: number | null;
  readonly title: string;
  readonly transcriptExcerpt: string;
  readonly reasons: readonly { readonly label: string; readonly explanation: string }[];
  readonly scoreBreakdown: Readonly<Record<string, number>> | null;
  readonly copy: unknown;
  readonly judgement: Readonly<Record<string, unknown>> | null;
  readonly state: string;
}

/** One size of a clip: its captioned video, to play and to download. */
export interface ExampleFormat {
  readonly shape: string;
  readonly status: "ready";
  /** Always null: no project of the example is anyone's to open. */
  readonly projectId: null;
  readonly captioned: CaptionedClipView;
  /** Always null: the example offers the finished videos, not the clean cuts. */
  readonly cleanUrl: null;
}

/** A finished clip of the example, as the results grid reads it. */
export interface ExampleClip {
  readonly id: string;
  readonly candidateId: string;
  readonly title: string;
  readonly state: "ready";
  readonly failureCode: null;
  readonly mezzanineUrl: null;
  readonly variants: readonly never[];
  readonly captioned: CaptionedClipView;
  readonly formats: readonly ExampleFormat[];
  readonly images: ClipImagesView;
  readonly copy: unknown;
}

export interface ExampleRunView {
  readonly available: true;
  readonly run: {
    /** The video's title, or a plain stand-in. Never the workspace's or a person's name. */
    readonly title: string;
    readonly source: "link" | "file";
    readonly automation: "auto" | "manual";
    /** How much of the video the run looked at, when known. */
    readonly processedMs: number | null;
    readonly clipCount: number;
  };
  readonly candidates: readonly ExampleCandidate[];
  readonly clips: readonly ExampleClip[];
  /** Each clip's words, by moment id. */
  readonly transcripts: Readonly<Record<string, ExampleTranscript>>;
  /** When the earliest signed URL in this answer stops working; the page reads again before. */
  readonly urlsExpireAt: string;
}

export type ExampleRunResponse = ExampleRunUnavailable | ExampleRunView;

const UNAVAILABLE: ExampleRunUnavailable = Object.freeze({ available: false });

/**
 * The example run (2026-10-01, OpusClip's "try a sample project"): one
 * finished run every signed-in person may open, read only, so someone new sees
 * scored clips, why they scored, every size and the images before spending a
 * credit.
 *
 * **Which run** is the owner's choice, `DEMO_RUN_ID` (`@montaj/config`
 * `demoRunIdFrom`), read on every call. Unset, malformed, a run that does not
 * exist, whose workspace or source project was deleted, or that has no
 * finished captioned clip, answers `{available: false}`, and the pages never
 * mention an example. So it ships inert.
 *
 * **Read only, in every sense.** Nothing here writes: the clips come from
 * `RepurposeClipsService.readClips`, which skips the list's reconcile (a
 * stranger's visit must not move another workspace's work on), and no route
 * of the example changes anything. The answer is built from an allow-list of
 * fields, never by spreading a row: no workspace id, project id, storage key,
 * member, creator, reviewer or rights attestation is in it, and no clean cut
 * (only finished, captioned videos and the images). What a signed URL's own
 * path names is the object's key, as every signed URL in the product does
 * (`guest-page.service.ts` says the same of guest links); that is the one
 * place the run's storage prefix is visible.
 *
 * **Cached** for {@link EXAMPLE_CACHE_MS} in this process, one entry, with
 * concurrent first reads sharing one build: every signed-in person who opens
 * the page gets the same answer, so there is no reason to read it twice.
 */
@Injectable()
export class ExampleRunService {
  private readonly logger = new Logger(ExampleRunService.name);

  /** A field so a test can set the clock. */
  now: () => number = () => Date.now();
  /** A field so a test can name the run without touching the process environment. */
  runId: () => string | null = () => demoRunIdFrom(process.env);

  private cached: {
    readonly runId: string | null;
    readonly at: number;
    readonly value: ExampleRunResponse;
  } | null = null;
  private building: {
    readonly runId: string | null;
    readonly value: Promise<ExampleRunResponse>;
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clips: RepurposeClipsService,
  ) {}

  /** The example as the page shows it, or `{available: false}`. Never throws for a bad run. */
  async view(): Promise<ExampleRunResponse> {
    const runId = this.runId();
    if (runId === null) return UNAVAILABLE;
    const now = this.now();
    const cached = this.cached;
    if (cached !== null && cached.runId === runId && now - cached.at < EXAMPLE_CACHE_MS) {
      return cached.value;
    }
    if (this.building !== null && this.building.runId === runId) return this.building.value;

    const value = this.build(runId)
      .catch((error: unknown) => {
        this.logger.warn({ runId, err: error }, "could not read the example run");
        return UNAVAILABLE;
      })
      .then((result) => {
        this.cached = { runId, at: this.now(), value: result };
        return result;
      })
      .finally(() => {
        if (this.building?.runId === runId) this.building = null;
      });
    this.building = { runId, value };
    return value;
  }

  private async build(runId: string): Promise<ExampleRunResponse> {
    const run = await this.prisma.repurposeRun.findFirst({
      where: {
        id: runId,
        workspace: { deletedAt: null },
        sourceProject: { deletedAt: null },
      },
      include: { sourceProject: { select: { title: true } } },
    });
    if (run === null) {
      this.logger.warn({ runId }, "DEMO_RUN_ID names no run that can be shown");
      return UNAVAILABLE;
    }

    const items = await this.clips.readClips(run);
    const clips = items
      .map((item) => exampleClipOf(item))
      .filter((clip): clip is ExampleClip => clip !== null);
    if (clips.length === 0) {
      this.logger.warn({ runId }, "the example run has no finished clip to show");
      return UNAVAILABLE;
    }

    const shown = new Set(clips.map((clip) => clip.candidateId));
    const rows = await this.prisma.clipCandidate.findMany({
      where: { runId: run.id },
      orderBy: [{ rank: "asc" }, { potentialScore: "desc" }],
    });
    const candidates = rows
      .filter((row) => shown.has(row.id) && !isRemoved(row))
      .map((row) => exampleCandidateOf(row));
    const kept = new Set(candidates.map((candidate) => candidate.id));
    const listed = clips.filter((clip) => kept.has(clip.candidateId));
    if (listed.length === 0) return UNAVAILABLE;

    const lines = await runTranscriptLines(this.prisma, run, candidates);
    const offsetMs = run.windowStartMs ?? 0;
    const transcripts: Record<string, ExampleTranscript> = {};
    for (const candidate of candidates) {
      transcripts[candidate.id] = { offsetMs, lines: lines.get(candidate.id) ?? [] };
    }

    return {
      available: true,
      run: {
        title:
          cleanSourceTitle(run.sourceTitle) ??
          cleanSourceTitle(run.sourceProject.title) ??
          "An example video",
        source: run.sourceKind === "upload" ? "file" : "link",
        automation: automationOf(run),
        processedMs: processedMsOf(run),
        clipCount: listed.length,
      },
      candidates,
      clips: listed,
      transcripts,
      urlsExpireAt: new Date(this.now() + URL_TTL_MS).toISOString(),
    };
  }
}

function processedMsOf(run: RepurposeRun): number | null {
  if (run.windowStartMs !== null && run.windowEndMs !== null) {
    return Math.max(0, run.windowEndMs - run.windowStartMs);
  }
  return run.sourceDurationMs;
}

/** A captioned video, re-built field by field. Null without a file to play. */
function captionedOf(view: CaptionedClipView | null | undefined): CaptionedClipView | null {
  if (view === null || view === undefined || view.playUrl === null) return null;
  return {
    status: view.status,
    playUrl: view.playUrl,
    downloadUrl: view.downloadUrl,
    durationMs: view.durationMs ?? null,
  };
}

/**
 * A finished clip of the example, from the run page's own item - field by
 * field, so nothing the item carries (its project ids, its mezzanine key, its
 * child media) reaches the answer. Only a ready clip with a captioned video
 * to play is an example; every other one is left out.
 */
export function exampleClipOf(item: RepurposeClipItemView): ExampleClip | null {
  if (item.state !== "ready") return null;
  const captioned = captionedOf(item.captioned);
  if (captioned === null) return null;
  const formats: ExampleFormat[] = [];
  for (const format of item.formats) {
    const video = captionedOf(format.captioned);
    if (video === null) continue;
    formats.push({
      shape: format.shape,
      status: "ready",
      projectId: null,
      captioned: video,
      cleanUrl: null,
    });
  }
  const title = typeof item["title"] === "string" ? item["title"] : "";
  return {
    id: item.id,
    candidateId: item.candidateId,
    title,
    state: "ready",
    failureCode: null,
    mezzanineUrl: null,
    variants: [],
    captioned,
    formats,
    images: {
      status: item.images.files.length === 0 ? "none" : "ready",
      files: item.images.files.map((file) => ({
        id: file.id,
        width: file.width,
        height: file.height,
        items: file.items.map((entry) => ({ url: entry.url, downloadUrl: entry.downloadUrl })),
      })),
    },
    copy: copyOf(item["copy"]),
  };
}

/** The words to post, only when they pass the contract; `{}` otherwise. */
function copyOf(value: unknown): unknown {
  const parsed = ClipCopySchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** The language model's marks and notes, by the keys the page reads; nothing else. */
const JUDGEMENT_KEYS = [
  "standalone",
  "payoff",
  "humour",
  "topicFit",
  "hook",
  "trend",
  "model",
  "notes",
  "people",
] as const;

function judgementOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of JUDGEMENT_KEYS) {
    // eslint-disable-next-line security/detect-object-injection -- a closed list of keys
    const entry = source[key];
    if (entry === undefined) continue;
    if (key === "notes") {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const notes: Record<string, string> = {};
      for (const [part, note] of Object.entries(entry as Record<string, unknown>)) {
        // eslint-disable-next-line security/detect-object-injection -- copying a plain record
        if (typeof note === "string") notes[part] = note;
      }
      picked["notes"] = notes;
    } else if (key === "people") {
      if (Array.isArray(entry)) {
        picked["people"] = entry.filter((name): name is string => typeof name === "string");
      }
    } else if (typeof entry === "number" || typeof entry === "string") {
      // eslint-disable-next-line security/detect-object-injection -- a closed list of keys
      picked[key] = entry;
    }
  }
  return picked;
}

function scoreBreakdownOf(value: unknown): Readonly<Record<string, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const numbers: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // eslint-disable-next-line security/detect-object-injection -- copying a plain record of numbers
    if (typeof entry === "number" && Number.isFinite(entry)) numbers[key] = entry;
  }
  return numbers;
}

function reasonsOf(value: unknown): ExampleCandidate["reasons"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { label, explanation } = entry as Record<string, unknown>;
    return typeof label === "string" && typeof explanation === "string"
      ? [{ label, explanation }]
      : [];
  });
}

/** A moment of the example, field by field: no run, transcript or model-run ids. */
export function exampleCandidateOf(row: ClipCandidate): ExampleCandidate {
  return {
    id: row.id,
    startMs: row.startMs,
    endMs: row.endMs,
    rank: row.rank,
    potentialScore: row.potentialScore,
    title: row.title,
    transcriptExcerpt: row.transcriptExcerpt,
    reasons: reasonsOf(row.reasons),
    scoreBreakdown: scoreBreakdownOf(row.scoreBreakdown),
    copy: copyOf(row.copy),
    judgement: judgementOf(row.judgement),
    state: row.state,
  };
}
