import { describe, expect, it, vi } from "vitest";

import { TranscriptChunkSchema } from "@montaj/edg/schemas";
import { REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

import { RepurposeClipCompletionHandler } from "./clip-completion.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { Job } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const RUN = "01JCRN0000000000000000000A";
const SRC = "01JCSRCPR0JECT000000000000";
const CHILD = "01JCCH1LDPR0JECT0000000000";
const CLIP = "01JCC11P000000000000000000";
const CAND = "01JCCANDA00000000000000000";
const JOB = "01JCJ0B0000000000000000000";
const CHILD_MEDIA = "01JCCH1LDMED1A000000000000";
const SOURCE_TRANSCRIPT = "01JCSRCTRANSCR1PT000000000";
const MEZZANINE = `ws/${WS}/p/${SRC}/repurpose/${RUN}/clips/${CAND}/master.mp4`;
const OLD_FACES = `ws/${WS}/p/${CHILD}/media/${CHILD_MEDIA}/faces.json`;

type Row = Record<string, unknown>;

function clipResult(overrides: Row = {}): Record<string, unknown> {
  return {
    schemaVersion: REPURPOSE_SCHEMA_VERSION,
    clipId: CLIP,
    bucket: "s3",
    key: MEZZANINE,
    checksum: "a".repeat(64),
    sizeBytes: 4_096,
    durationMs: 31_000,
    effectiveStartMs: 1_199_500,
    effectiveEndMs: 1_230_500,
    leadHandleMs: 500,
    tailHandleMs: 500,
    hasAudio: true,
    deduplicated: false,
    ...overrides,
  };
}

function context(
  result: Record<string, unknown>,
  params: Row | null = { runId: RUN, clipId: CLIP, destination: { bucket: "s3", key: MEZZANINE } },
): JobCompletionContext {
  return {
    job: { id: JOB, workspaceId: WS, projectId: SRC, type: "media.clip", params } as unknown as Job,
    attemptId: "01JCATTEMPT000000000000000",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
  };
}

interface Options {
  run?: Row;
  /** The child's primary media, or null for a first cut. */
  childMedia?: Row | null;
  /** The child's existing transcript, and whether it has chunks. */
  childTranscript?: { id: string; chunks: number } | null;
  childDocument?: boolean;
  sourceWords?: Row[][];
  /** Rows `settleRunAfterClips` reads. */
  clips?: Row[];
  jobs?: Row[];
  chunkWriteFails?: boolean;
  deleteFails?: boolean;
  /** The clip's run no longer exists. */
  runGone?: boolean;
}

function harness(options: Options = {}) {
  const run = {
    id: RUN,
    workspaceId: WS,
    sourceProjectId: SRC,
    status: "materializing",
    currentStage: "styles_formats",
    failureCode: null,
    progress: 65,
    config: { sourceLanguage: "en", caption: { styleId: "punch-pop" } },
    createdBy: "01JCUSER000000000000000000",
    ...options.run,
  };

  const tx = {
    transcript: {
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    transcriptChunk: {
      create: vi.fn(async () => {
        if (options.chunkWriteFails === true) throw new Error("connection reset");
        return {};
      }),
    },
  };

  const childMedia = options.childMedia === undefined ? null : options.childMedia;
  const mediaUpdate = vi.fn(async (args: { data: Row }) => ({ ...childMedia, ...args.data }));
  const runUpdate = vi.fn(async (args: { data: Row }) => ({ ...run, ...args.data }));
  /** Applies `data` to the run when `where` matches it, as the database would. */
  const runUpdateMany = vi.fn(async (args: { where: Row; data: Row }) => {
    if (!runMatches(run, args.where)) return { count: 0 };
    Object.assign(run, args.data);
    return { count: 1 };
  });
  const clipUpdate = vi.fn(async () => ({}));

  const sourceChunks = (options.sourceWords ?? []).map((words, chunkIdx) => ({
    id: `chunk-${String(chunkIdx)}`,
    transcriptId: SOURCE_TRANSCRIPT,
    chunkIdx,
    revision: 1,
    words,
  }));

  const prisma = {
    repurposeClip: {
      findUnique: vi.fn(async () => ({
        id: CLIP,
        runId: RUN,
        candidateId: CAND,
        title: "A moment",
        // A snapshot, as read at the start of `handle`.
        run: options.runGone === true ? null : { ...run },
        candidate: { id: CAND },
      })),
      update: clipUpdate,
      findMany: vi.fn(async () => options.clips ?? []),
    },
    clipVariant: {
      findUnique: vi.fn(async () =>
        options.childMedia === undefined
          ? null
          : { id: "01JCVAR1ANT000000000000000", projectId: CHILD },
      ),
      upsert: vi.fn(async () => ({})),
    },
    project: {
      findUnique: vi.fn(async () => ({ sourceLanguage: "en", scripts: [] })),
      update: vi.fn(async () => ({})),
      findUniqueOrThrow: vi.fn(async () => ({ id: CHILD, workspaceId: WS, status: "draft" })),
    },
    mediaAsset: {
      findFirst: vi.fn(async () => childMedia),
      create: vi.fn(async (args: { data: Row }) => ({ facesKey: null, ...args.data })),
      update: mediaUpdate,
    },
    transcript: {
      findFirst: vi.fn(async (args: { where: Row }) => {
        if (args.where["projectId"] === CHILD) {
          const existing = options.childTranscript ?? null;
          return existing === null
            ? null
            : { id: existing.id, _count: { chunks: existing.chunks } };
        }
        return sourceChunks.length === 0 ? null : { id: SOURCE_TRANSCRIPT, language: "en" };
      }),
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    transcriptChunk: {
      findMany: vi.fn(async () => sourceChunks),
      create: vi.fn(async () => ({})),
    },
    edgDocument: {
      findUnique: vi.fn(async () => (options.childDocument === true ? { id: "EDG1" } : null)),
    },
    repurposeRun: {
      update: runUpdate,
      findUnique: vi.fn(async () => ({ ...run })),
      updateMany: runUpdateMany,
    },
    job: { findMany: vi.fn(async () => options.jobs ?? []) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const completeAcquisition = vi.fn(async () => ({ media: { id: CHILD_MEDIA }, probeJobId: "P" }));
  const publishStage = vi.fn(async () => undefined);
  const reconcileRun = vi.fn(async () => undefined);
  const raw = {
    kind: "s3",
    head: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
  };
  const derived = {
    kind: "r2",
    head: vi.fn(async () => ({ sizeBytes: 4_096 })),
    get: vi.fn(async () => Buffer.alloc(4_096)),
    delete: vi.fn(async () => {
      if (options.deleteFails === true) throw new Error("NoSuchKey");
    }),
  };

  const handler = new RepurposeClipCompletionHandler(
    prisma as never,
    { create: vi.fn(async () => ({ id: CHILD })) } as never,
    { completeAcquisition } as never,
    { publishStage, reconcileRun } as never,
    new JobCompletionRegistry(),
    { publish: vi.fn() } as never,
    raw as never,
    derived as never,
  );
  return {
    handler,
    prisma,
    tx,
    run,
    mediaUpdate,
    runUpdate,
    runUpdateMany,
    clipUpdate,
    completeAcquisition,
    publishStage,
    reconcileRun,
    raw,
    derived,
  };
}

/** Just enough of Prisma's `where` for the run writes these handlers make. */
function runMatches(run: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some((branch) => runMatches(run, branch));
    const value = new Map(Object.entries(run)).get(key);
    if (condition !== null && typeof condition === "object" && "in" in condition) {
      return (condition as { in: unknown[] }).in.includes(value);
    }
    return value === condition;
  });
}

/** Source words 20 minutes in: chunk 2 of a long talk. */
function lateWords(): Row[][] {
  return [
    [],
    [{ wid: "1:900", s: 1_199_000, e: 1_199_400, t: "before", sp: "S1" }],
    [
      { wid: "2:0", s: 1_200_000, e: 1_200_400, t: "the", sp: "S1", scripts: { roman: "the" } },
      { wid: "2:1", s: 1_200_500, e: 1_201_000, t: "gone", deleted: true },
      { wid: "2:2", s: 1_201_000, e: 1_201_600, t: "point", sp: "S1" },
      { wid: "2:3", s: 1_230_000, e: 1_230_400, t: "lands", sp: "S1" },
      { wid: "2:4", s: 1_231_000, e: 1_231_400, t: "after", sp: "S1" },
    ],
  ];
}

function writtenChunk(h: ReturnType<typeof harness>): Row {
  const call = h.tx.transcriptChunk.create.mock.calls[0] as unknown as [{ data: Row }] | undefined;
  if (call === undefined) throw new Error("no chunk was written");
  return call[0].data;
}

describe("RepurposeClipCompletionHandler — a failed cut", () => {
  it("never fails the run, and leaves one still waiting on other clips alone", async () => {
    const h = harness({
      clips: [
        { candidateId: CAND, mezzanineKey: null },
        { candidateId: "01JCCANDB00000000000000000", mezzanineKey: null },
      ],
      jobs: [
        { id: JOB, jobKey: `media.clip:${CAND}:0-1:2`, status: "running", error: null },
        {
          id: "01JCJ0B0THER0000000000000A",
          jobKey: "media.clip:01JCCANDB00000000000000000:0-1:2",
          status: "running",
          error: null,
        },
      ],
    });
    await h.handler.handleFailure(context({}));
    expect(h.runUpdate).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
    expect(h.publishStage).not.toHaveBeenCalled();
    // The run still carries on from its durable state.
    expect(h.reconcileRun).toHaveBeenCalledWith(RUN);
  });

  it("moves the run on to review when the last clip it waited for fails and another is ready", async () => {
    const h = harness({
      clips: [
        { candidateId: CAND, mezzanineKey: null },
        { candidateId: "01JCCANDB00000000000000000", mezzanineKey: "ws/other.mp4" },
      ],
      jobs: [{ id: JOB, jobKey: `media.clip:${CAND}:0-1:2`, status: "running", error: null }],
    });
    await h.handler.handleFailure(context({}));
    expect(h.runUpdateMany).toHaveBeenCalledWith({
      where: { id: RUN, status: "materializing" },
      data: { status: "review_ready", currentStage: "review", progress: 85 },
    });
    expect(h.runUpdate).not.toHaveBeenCalled();
    expect(h.publishStage).toHaveBeenCalledTimes(1);
  });

  it("leaves a run under review exactly as it is", async () => {
    const h = harness({ run: { status: "review_ready" } });
    await h.handler.handleFailure(context({}));
    expect(h.runUpdate).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it("does nothing for a job whose params name no run", async () => {
    const h = harness();
    await h.handler.handleFailure(context({}, null));
    expect(h.prisma.repurposeRun.findUnique).not.toHaveBeenCalled();
  });
});

describe("RepurposeClipCompletionHandler — a finished cut", () => {
  it("keeps a cut that lands on a run which failed for another reason", async () => {
    // Previously dropped: one clip's failure threw away every sibling in flight.
    const h = harness({ run: { status: "failed", failureCode: "repurpose/highlights_failed" } });
    const outcome = await h.handler.handle(context(clipResult()));
    expect(outcome.data?.["applied"]).toBe(true);
    expect(h.clipUpdate).toHaveBeenCalledTimes(1);
    // The run keeps saying what really went wrong with it.
    expect(h.run).toMatchObject({ status: "failed", failureCode: "repurpose/highlights_failed" });
    expect(h.runUpdate).not.toHaveBeenCalled();
  });

  it("restores a run the old code failed for a clip", async () => {
    const h = harness({ run: { status: "failed", failureCode: "repurpose/clip_failed" } });
    await h.handler.handle(context(clipResult()));
    expect(h.run).toMatchObject({
      status: "review_ready",
      currentStage: "review",
      progress: 85,
      failureCode: null,
    });
    expect(h.publishStage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "review_ready" }),
    );
  });

  it("moves a run waiting on its clips to review, and leaves one still analysing alone", async () => {
    const waiting = harness({ run: { status: "candidates_ready" } });
    await waiting.handler.handle(context(clipResult()));
    expect(waiting.run.status).toBe("review_ready");
    // A clip that waited for a slot is the run's next piece of work.
    expect(waiting.reconcileRun).toHaveBeenCalledWith(RUN);

    const analysing = harness({ run: { status: "analyzing" } });
    await analysing.handler.handle(context(clipResult()));
    expect(analysing.run.status).toBe("analyzing");
    expect(analysing.publishStage).toHaveBeenCalledTimes(1);
  });

  it("never brings back a run cancelled while the cut was being landed", async () => {
    // The copy into raw and the pipeline start come between reading the run
    // and moving it; an unconditional write turned `cancelled` into review_ready.
    const h = harness();
    h.completeAcquisition.mockImplementationOnce(async () => {
      h.run.status = "cancelled";
      return { media: { id: CHILD_MEDIA }, probeJobId: "P" };
    });
    await h.handler.handle(context(clipResult()));
    expect(h.runUpdate).not.toHaveBeenCalled();
    expect(h.run.status).toBe("cancelled");
    expect(h.publishStage).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("applies nothing when the worker reports a clip or key it was not asked for", async () => {
    // THREAT-MODEL T4: a worker must not attach another object — another
    // workspace's included — to a clip, nor have it copied into raw.
    for (const reported of [
      { key: `ws/01JCOTHERWS00000000000000/p/X/repurpose/R/clips/C/master.mp4` },
      { clipId: "01JCC11PB00000000000000000" },
    ]) {
      const h = harness({
        clips: [{ candidateId: CAND, mezzanineKey: null }],
        jobs: [{ id: JOB, jobKey: `media.clip:${CAND}:0-1:2`, status: "running", error: null }],
      });
      const outcome = await h.handler.handle(context(clipResult(reported)));
      expect(outcome.data).toMatchObject({ applied: false, reason: "result_mismatch" });
      expect(h.prisma.repurposeClip.findUnique).not.toHaveBeenCalled();
      expect(h.clipUpdate).not.toHaveBeenCalled();
      expect(h.raw.put).not.toHaveBeenCalled();
      // The job settles, so its clip reads failed and its run moves on.
      expect(h.run.status).toBe("candidates_ready");
    }
  });

  it("marks the child's media failed, instead of throwing, for a mezzanine too big to prepare", async () => {
    // A throw would leave the job running for redelivery, holding a lane slot,
    // with the same answer every time.
    const h = harness();
    const outcome = await h.handler.handle(context(clipResult({ sizeBytes: 600 * 1024 * 1024 })));
    expect(outcome.data?.["applied"]).toBe(true);
    const data = (h.mediaUpdate.mock.calls[0] as unknown as [{ data: Row }])[0].data;
    expect(data).toMatchObject({ status: "failed", failureReason: "media/too_large" });
    expect(h.raw.put).not.toHaveBeenCalled();
    expect(h.completeAcquisition).not.toHaveBeenCalled();
  });

  it("keeps a cut that finishes after the run was stopped, and leaves the run stopped", async () => {
    // The Stop dialog promises that clips being cut "still finish and stay", and
    // `stopRunJobs` leaves `media.clip` running for it. The handler used to turn
    // the cut away: the clip read failed, with no retry on a stopped run, and
    // the worker's picture was orphaned in the derived store.
    const h = harness({
      run: { status: "cancelled", currentStage: "styles_formats", progress: 65 },
    });
    const outcome = await h.handler.handle(context(clipResult()));

    expect(outcome.data).toMatchObject({ applied: true, clipId: CLIP });
    expect(h.clipUpdate).toHaveBeenCalledWith({
      where: { id: CLIP },
      data: expect.objectContaining({ mezzanineKey: MEZZANINE, mezzanineJobId: JOB }) as unknown,
    });
    expect(h.prisma.clipVariant.upsert).toHaveBeenCalledTimes(1);
    // The child project is made editable like any other clip's.
    expect(h.raw.put).toHaveBeenCalledTimes(1);
    expect(h.completeAcquisition).toHaveBeenCalledTimes(1);
    // ...and the run stays exactly as the person left it.
    expect(h.run).toMatchObject({
      status: "cancelled",
      currentStage: "styles_formats",
      progress: 65,
    });
    expect(h.runUpdate).not.toHaveBeenCalled();
  });

  it("turns a cut away only when its run no longer exists", async () => {
    const h = harness({ runGone: true });
    const outcome = await h.handler.handle(context(clipResult()));
    expect(outcome.data).toMatchObject({ applied: false, reason: "run_not_found" });
    expect(h.clipUpdate).not.toHaveBeenCalled();
    expect(h.raw.put).not.toHaveBeenCalled();
    expect(h.completeAcquisition).not.toHaveBeenCalled();
  });
});

describe("RepurposeClipCompletionHandler — the transcript slice", () => {
  it("gives the clip its own word ids, 0:0 onwards, in one chunk the schema accepts", async () => {
    // Keeping the source's `2:n` ids inside chunk 0 made every word edit on a
    // clip from late in a long source fail as unknown.
    const h = harness({ sourceWords: lateWords() });
    await h.handler.handle(context(clipResult()));

    const chunk = writtenChunk(h);
    const words = chunk["words"] as Row[];
    expect(words.map((w) => [w["wid"], w["t"], w["s"], w["e"]])).toEqual([
      ["0:0", "the", 500, 900],
      ["0:1", "point", 1_500, 2_100],
      ["0:2", "lands", 30_500, 30_900],
    ]);
    expect(chunk["chunkIdx"]).toBe(0);
    expect(chunk["nextWordSeq"]).toBe(3);
    // Everything else the source word carried comes along.
    expect(words[0]).toMatchObject({ sp: "S1", scripts: { roman: "the" } });
    expect(() =>
      TranscriptChunkSchema.parse({
        chunkIdx: chunk["chunkIdx"],
        startMs: chunk["startMs"],
        endMs: chunk["endMs"],
        words,
      }),
    ).not.toThrow();
  });

  it("writes the transcript and its chunk together, or not at all", async () => {
    const h = harness({ sourceWords: lateWords(), chunkWriteFails: true });
    const outcome = await h.handler.handle(context(clipResult()));

    // Both writes went through the transaction, so the failed chunk takes the
    // transcript row with it and the clip is transcribed from scratch instead.
    expect(h.tx.transcript.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.transcript.create).not.toHaveBeenCalled();
    expect(h.prisma.transcriptChunk.create).not.toHaveBeenCalled();
    // The clip itself still lands.
    expect(outcome.data?.["applied"]).toBe(true);
    expect(h.completeAcquisition).toHaveBeenCalledTimes(1);
  });

  it("writes no transcript for a slice with no words, so the clip is transcribed on its own", async () => {
    const h = harness({ sourceWords: lateWords() });
    await h.handler.handle(
      context(clipResult({ effectiveStartMs: 1_300_000, effectiveEndMs: 1_330_000 })),
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.transcript.create).not.toHaveBeenCalled();
  });

  it("does not copy a source whose word timings are all zero", async () => {
    // Sarvam transcripts from before 2026-09-17: every word at 0 ms, which
    // would put the whole video's words on the clip.
    const h = harness({
      sourceWords: [
        [
          { wid: "0:0", s: 0, e: 0, t: "every" },
          { wid: "0:1", s: 0, e: 0, t: "word" },
        ],
      ],
    });
    await h.handler.handle(context(clipResult({ effectiveStartMs: 0, effectiveEndMs: 31_000 })));
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("changes nothing on a replay once the clip has its words", async () => {
    const h = harness({
      sourceWords: lateWords(),
      childTranscript: { id: "01JCCH1LDTRANSCR1PT0000000", chunks: 1 },
    });
    await h.handler.handle(context(clipResult()));
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.transcript.delete).not.toHaveBeenCalled();
  });

  it("replaces an empty transcript an older cut left behind, in the same transaction", async () => {
    const stale = "01JCSTALETRANSCR1PT0000000";
    const h = harness({ sourceWords: lateWords(), childTranscript: { id: stale, chunks: 0 } });
    await h.handler.handle(context(clipResult()));
    expect(h.tx.transcript.delete).toHaveBeenCalledWith({ where: { id: stale } });
    expect(h.tx.transcriptChunk.create).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty transcript alone once a document is built on it", async () => {
    const h = harness({
      sourceWords: lateWords(),
      childTranscript: { id: "01JCSTALETRANSCR1PT0000000", chunks: 0 },
      childDocument: true,
    });
    await h.handler.handle(context(clipResult()));
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.transcript.delete).not.toHaveBeenCalled();
  });
});

describe("RepurposeClipCompletionHandler — a re-cut", () => {
  const settled = {
    id: CHILD_MEDIA,
    projectId: CHILD,
    status: "ready",
    contentHash: "b".repeat(64),
    facesKey: OLD_FACES,
    storageKey: MEZZANINE,
  };

  it("clears the old face track so the new picture is detected again", async () => {
    const h = harness({ childMedia: settled });
    await h.handler.handle(context(clipResult()));

    const data = (h.mediaUpdate.mock.calls[0] as unknown as [{ data: Row }])[0].data;
    expect(data["facesKey"]).toBeNull();
    expect(data["status"]).toBe("pending");
    expect(h.derived.delete).toHaveBeenCalledWith(OLD_FACES);
  });

  it("still lands the cut when the old face track cannot be deleted", async () => {
    const h = harness({ childMedia: settled, deleteFails: true });
    const outcome = await h.handler.handle(context(clipResult()));
    expect(outcome.data?.["applied"]).toBe(true);
  });

  it("keeps the face track on a replay of the same cut", async () => {
    const h = harness({ childMedia: { ...settled, contentHash: "a".repeat(64) } });
    await h.handler.handle(context(clipResult()));
    expect(h.mediaUpdate).not.toHaveBeenCalled();
    expect(h.derived.delete).not.toHaveBeenCalled();
  });
});
