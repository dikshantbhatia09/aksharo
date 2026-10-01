import { describe, expect, it, vi } from "vitest";

import { AutoTranscribeTrigger } from "./auto-transcribe.trigger.js";
import { RunCaptionsAligner } from "./run-captions.aligner.js";

import type { TranscriptDocumentService } from "./transcript-document.service.js";
import type { TranscriptsService } from "./transcripts.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { JobsService } from "../jobs/jobs.service.js";

/**
 * A clips run started with captions the person already has (2026-10-01): the
 * step that would have been a paid transcription becomes an `ai.align` of
 * those captions, through the editor import's own job shape.
 */

const WS = "01WORKSPACE";
const PROJECT = "01PROJECT";
const MEDIA = "01MEDIA";
const SUBTITLE = "01SUBTITLE";
const SIDECAR_KEY = `ws/${WS}/p/${PROJECT}/subtitles/${SUBTITLE}.json`;

const CUES = [
  { index: 1, startMs: 0, endMs: 2_000, text: "hello there" },
  { index: 2, startMs: 2_000, endMs: 4_500, text: "and\nwelcome  back" },
  { index: 3, startMs: 61_000, endMs: 63_000, text: "a minute in" },
];

function sidecar(cues: readonly unknown[] = CUES): string {
  return JSON.stringify({
    version: 1,
    kind: "srt",
    timed: true,
    language: "en",
    alignsMediaId: null,
    sourceUrl: null,
    importedAt: "2026-10-01T09:00:00.000Z",
    cues,
  });
}

interface JobRow {
  id: string;
  status: string;
  startedAt: Date | null;
}

function harness(
  options: {
    /** The run's frozen config; `null` for a project that is no run's source. */
    config?: Record<string, unknown> | null;
    window?: { startMs: number | null; endMs: number | null };
    /** Earlier aligns of the caption file, newest first. */
    jobs?: readonly JobRow[];
    sidecarRow?: { storageKey: string } | null;
    /** What the derived store answers; a function that throws simulates a blink. */
    stored?: string | (() => never);
    enqueue?: () => Promise<{ job: { id: string } }>;
  } = {},
) {
  const config =
    options.config === undefined
      ? {
          captions: { subtitleMediaId: SUBTITLE, kind: "srt", cueCount: 3, from: "file" },
        }
      : options.config;
  const prisma = {
    repurposeRun: {
      findFirst: vi.fn(async () =>
        config === null
          ? null
          : {
              id: "01RUN",
              config,
              windowStartMs: options.window?.startMs ?? null,
              windowEndMs: options.window?.endMs ?? null,
            },
      ),
    },
    job: { findMany: vi.fn(async () => options.jobs ?? []) },
    mediaAsset: {
      findFirst: vi.fn(async () =>
        options.sidecarRow === undefined ? { storageKey: SIDECAR_KEY } : options.sidecarRow,
      ),
    },
  };
  const enqueue = vi.fn(options.enqueue ?? (async () => ({ job: { id: "01ALIGN" } })));
  const stored = options.stored ?? sidecar();
  const derived = {
    kind: "s3-derived",
    get: vi.fn(async () => {
      if (typeof stored === "function") stored();
      return Buffer.from(stored as string, "utf8");
    }),
  };
  const aligner = new RunCaptionsAligner(
    prisma as unknown as PrismaService,
    { enqueue } as unknown as JobsService,
    derived as unknown as ObjectStore,
  );
  return { aligner, prisma, enqueue, derived };
}

const ASK = { early: false, laneHasRoomToSpare: async () => true };

interface EnqueueArgs {
  type: string;
  jobKey: string;
  worstCaseTenths: number;
  params: {
    mode: string;
    mediaId: string;
    subtitleMediaId: string;
    subtitleKey: string;
    subtitleBucket: string;
    language: string | null;
    cueCount: number;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
    cueWordCounts: number[];
  };
}

function enqueued(enqueue: ReturnType<typeof harness>["enqueue"]): EnqueueArgs {
  const call = (enqueue.mock.calls as unknown as Array<[EnqueueArgs]>)[0];
  if (call === undefined) throw new Error("nothing enqueued");
  return call[0];
}

describe("RunCaptionsAligner", () => {
  it("is nothing to do with a project that is no captions run's source", async () => {
    const none = harness({ config: null });
    await expect(
      none.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "not_captions" });
    const plain = harness({ config: { automation: "auto" } });
    await expect(
      plain.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "not_captions" });
    expect(plain.enqueue).not.toHaveBeenCalled();
  });

  it("aligns the captions to the audio as the editor's import does, for no credits", async () => {
    const h = harness();
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "queued", jobId: "01ALIGN" });

    const job = enqueued(h.enqueue);
    expect(job.type).toBe("ai.align");
    expect(job.jobKey).toBe(`ai.align:${SUBTITLE}`);
    expect(job.worstCaseTenths).toBe(0);
    expect(job.params).toMatchObject({
      mode: "import",
      mediaId: MEDIA,
      subtitleMediaId: SUBTITLE,
      subtitleKey: SIDECAR_KEY,
      subtitleBucket: "s3-derived",
      language: "en",
      cueCount: 3,
    });
    // One normalisation for the texts and the counts the completion splits by.
    expect(job.params.segments[1]).toEqual({
      startMs: 2_000,
      endMs: 4_500,
      text: "and welcome back",
    });
    expect(job.params.cueWordCounts).toEqual([2, 3, 3]);
  });

  it("moves the cues onto the clock of the part of the video the run downloaded", async () => {
    const h = harness({ window: { startMs: 60_000, endMs: 120_000 } });
    await h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK);
    expect(enqueued(h.enqueue).params.segments).toEqual([
      { startMs: 1_000, endMs: 3_000, text: "a minute in" },
    ]);
  });

  it("calls captions with none inside the window unusable, so the run is transcribed instead", async () => {
    const h = harness({ window: { startMs: 600_000, endMs: 900_000 } });
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toMatchObject({ kind: "unusable" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("calls a missing or unreadable file unusable", async () => {
    const gone = harness({ sidecarRow: null });
    await expect(
      gone.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toMatchObject({ kind: "unusable" });
    const garbled = harness({ stored: "not json" });
    await expect(
      garbled.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toMatchObject({ kind: "unusable" });
  });

  it("waits, never spends, when the store blinks or the queue refuses", async () => {
    const blink = harness({
      stored: () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(
      blink.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "waiting" });
    const refused = harness({
      enqueue: async () => {
        throw new Error("lane full");
      },
    });
    await expect(
      refused.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "waiting" });
  });

  it("answers with an align that is already open", async () => {
    const h = harness({ jobs: [{ id: "01OPEN", status: "running", startedAt: new Date() }] });
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "queued", jobId: "01OPEN" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("does not start again on the pipeline's own ask after a worker ran one", async () => {
    const h = harness({ jobs: [{ id: "01DONE", status: "failed", startedAt: new Date() }] });
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, {
        ...ASK,
        firstAttemptOnly: true,
      }),
    ).resolves.toEqual({ kind: "waiting" });
    // A run's Try again asks without it, and gets a fresh align.
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, ASK),
    ).resolves.toEqual({ kind: "queued", jobId: "01ALIGN" });
  });

  it("leaves the plan lane's last slot alone on early audio", async () => {
    const h = harness();
    await expect(
      h.aligner.maybeEnqueue({ id: PROJECT, workspaceId: WS }, MEDIA, {
        early: true,
        laneHasRoomToSpare: async () => false,
      }),
    ).resolves.toEqual({ kind: "waiting" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("AutoTranscribeTrigger with a run's own captions", () => {
  function trigger(start: Awaited<ReturnType<RunCaptionsAligner["maybeEnqueue"]>>) {
    const prisma = {
      mediaAsset: {
        findUnique: vi.fn(async () => ({
          id: MEDIA,
          projectId: PROJECT,
          role: "primary",
          status: "ready",
          durationMs: 20_000,
          audio16kKey: "a.wav",
          hasAudio: true,
        })),
      },
      project: {
        findFirst: vi.fn(async () => ({
          id: PROJECT,
          workspaceId: WS,
          createdBy: "01USER",
          sourceLanguage: "en",
          edgDocument: null,
        })),
      },
      transcript: { count: vi.fn(async () => 0) },
      repurposeRun: { findFirst: vi.fn(async () => null) },
      job: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      subscription: { findFirst: vi.fn(async () => null) },
    };
    const transcribe = vi.fn(async () => ({ jobId: "01PAID", deduplicated: false }));
    const captions = { maybeEnqueue: vi.fn(async () => start) };
    const subject = new AutoTranscribeTrigger(
      prisma as unknown as PrismaService,
      { transcribe } as unknown as TranscriptsService,
      { ensure: vi.fn() } as unknown as TranscriptDocumentService,
      { cancel: vi.fn() } as unknown as JobsService,
      captions as unknown as RunCaptionsAligner,
    );
    return { subject, transcribe, captions };
  }

  it("aligns instead of transcribing: no paid transcription is asked for", async () => {
    const t = trigger({ kind: "queued", jobId: "01ALIGN" });
    await expect(t.subject.maybeEnqueue(MEDIA)).resolves.toEqual({ jobId: "01ALIGN" });
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it("starts nothing paid while the align waits", async () => {
    const t = trigger({ kind: "waiting" });
    await expect(t.subject.maybeEnqueue(MEDIA)).resolves.toBeUndefined();
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it("transcribes as usual a project with no captions, or captions it cannot use", async () => {
    const plain = trigger({ kind: "not_captions" });
    await expect(plain.subject.maybeEnqueue(MEDIA)).resolves.toEqual({ jobId: "01PAID" });
    const unusable = trigger({ kind: "unusable", reason: "gone" });
    await expect(unusable.subject.maybeEnqueue(MEDIA)).resolves.toEqual({ jobId: "01PAID" });
  });

  it("tells the reconciler what the captions said, so a refused fallback is not a wait", async () => {
    const waiting = trigger({ kind: "waiting" });
    await expect(waiting.subject.startFirstTranscription(MEDIA)).resolves.toEqual({
      jobId: undefined,
      captions: "waiting",
    });

    const unusable = trigger({ kind: "unusable", reason: "gone" });
    unusable.transcribe.mockRejectedValueOnce(new Error("credits/insufficient"));
    await expect(unusable.subject.startFirstTranscription(MEDIA)).resolves.toEqual({
      jobId: undefined,
      captions: "unusable",
    });

    const queued = trigger({ kind: "queued", jobId: "01ALIGN" });
    await expect(queued.subject.startFirstTranscription(MEDIA)).resolves.toEqual({
      jobId: "01ALIGN",
      captions: "queued",
    });

    const plain = trigger({ kind: "not_captions" });
    await expect(plain.subject.startFirstTranscription(MEDIA)).resolves.toEqual({
      jobId: "01PAID",
      captions: "none",
    });
  });
});
