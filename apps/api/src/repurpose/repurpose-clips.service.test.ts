import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";
import { clipMasterKey, MediaClipPayloadSchema } from "@montaj/repurpose-contracts";

import { FACE_TRACK_WAIT_MS, faceDetectionRunWaitMs } from "./reframe.js";
import { REPURPOSE_CLIP_ERRORS } from "./repurpose-clips.dto.js";
import { RepurposeClipsService, timecode } from "./repurpose-clips.service.js";
import { CLIP_PROFILE_VERSION } from "./repurpose.constants.js";
import { AppException } from "../common/index.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { facesJobKey } from "../media/faces.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const SRC = "01JCSRCPR0JECT000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const CAND_A = "01JCCANDA00000000000000000";
const CAND_B = "01JCCANDB00000000000000000";
const TR = "01JCTRANSCR1PT000000000000";
const FACES_KEY = `ws/${WS}/p/${SRC}/media/${MEDIA}/faces.json`;

type Row = Record<string, unknown>;

interface Tables {
  runs: Row[];
  candidates: Row[];
  clips: Row[];
  variants: Row[];
  media: Row[];
  transcripts: Row[];
  chunks: Row[];
  jobs: Row[];
}

/** Just enough of Prisma's `where` for the queries this service makes. */
function matches(row: Row, where: Row | undefined): boolean {
  const fields = new Map(Object.entries(row));
  for (const [key, condition] of Object.entries(where ?? {})) {
    const value = fields.get(key);
    if (key === "OR") {
      if (!(condition as Row[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (condition !== null && typeof condition === "object") {
      const operator = condition as { startsWith?: string; in?: unknown[] };
      if (operator.startsWith !== undefined) {
        if (!String(value).startsWith(operator.startsWith)) return false;
        continue;
      }
      if (operator.in !== undefined) {
        if (!operator.in.includes(value)) return false;
        continue;
      }
    }
    if (value !== condition) return false;
  }
  return true;
}

let clock = 1_000;

function fakePrisma(t: Tables) {
  const withIncludes = (clip: Row, include?: Row): Row => ({
    ...clip,
    ...(include?.["candidate"] === undefined
      ? {}
      : { candidate: t.candidates.find((c) => c["id"] === clip["candidateId"]) }),
    ...(include?.["variants"] === undefined
      ? {}
      : {
          variants: t.variants
            .filter((v) => v["clipId"] === clip["id"])
            .map((v) => ({
              ...v,
              project: { mediaAssets: t.media.filter((m) => m["projectId"] === v["projectId"]) },
            })),
        }),
  });
  const findOne = (rows: Row[]) => async (args: { where: Row }) =>
    rows.find((row) => matches(row, args.where)) ?? null;
  /** `orderBy: { createdAt: "desc" }` — the newest row is the last one pushed. */
  const findNewest = (rows: Row[]) => async (args: { where: Row }) =>
    [...rows].reverse().find((row) => matches(row, args.where)) ?? null;

  return {
    repurposeRun: {
      findFirst: vi.fn(findOne(t.runs)),
      findUnique: vi.fn(findOne(t.runs)),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        const hit = t.runs.filter((run) => matches(run, args.where));
        for (const run of hit) Object.assign(run, args.data);
        return { count: hit.length };
      }),
    },
    clipCandidate: {
      findFirst: vi.fn(findOne(t.candidates)),
      count: vi.fn(
        async (args: { where: Row }) => t.candidates.filter((c) => matches(c, args.where)).length,
      ),
      create: vi.fn(async (args: { data: Row }) => {
        const row = { reasons: [], createdAt: new Date(clock++), ...args.data };
        t.candidates.push(row);
        return row;
      }),
    },
    repurposeClip: {
      findUnique: vi.fn(async (args: { where: Row; include?: Row }) => {
        const clip = t.clips.find((row) => matches(row, args.where));
        return clip === undefined ? null : withIncludes(clip, args.include);
      }),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        const clip = t.clips.find((row) => matches(row, args.where));
        if (clip === undefined) throw new Error("not found");
        return Object.assign(clip, args.data);
      }),
      findFirst: vi.fn(async (args: { where: Row; include?: Row }) => {
        const clip = t.clips.find((row) => matches(row, args.where));
        return clip === undefined ? null : withIncludes(clip, args.include);
      }),
      findUniqueOrThrow: vi.fn(async (args: { where: Row; include?: Row }) => {
        const clip = t.clips.find((row) => matches(row, args.where));
        if (clip === undefined) throw new Error("not found");
        return withIncludes(clip, args.include);
      }),
      findMany: vi.fn(async (args: { where: Row; include?: Row }) =>
        t.clips.filter((row) => matches(row, args.where)).map((c) => withIncludes(c, args.include)),
      ),
      count: vi.fn(
        async (args: { where: Row }) => t.clips.filter((c) => matches(c, args.where)).length,
      ),
      create: vi.fn(async (args: { data: Row }) => {
        const at = new Date(clock++);
        const row = {
          mezzanineKey: null,
          mezzanineJobId: null,
          createdAt: at,
          updatedAt: at,
          ...args.data,
        };
        t.clips.push(row);
        // A snapshot, as Prisma returns: later writes to the row are not seen.
        return { ...row };
      }),
      deleteMany: vi.fn(async (args: { where: Row }) => {
        const doomed = t.clips.filter((row) => matches(row, args.where));
        for (const row of doomed) t.clips.splice(t.clips.indexOf(row), 1);
        return { count: doomed.length };
      }),
    },
    clipVariant: { findFirst: vi.fn(findOne(t.variants)) },
    mediaAsset: { findFirst: vi.fn(findNewest(t.media)) },
    transcript: { findFirst: vi.fn(findNewest(t.transcripts)) },
    transcriptChunk: {
      findMany: vi.fn(async (args: { where: Row }) =>
        t.chunks
          .filter((c) => c["transcriptId"] === args.where["transcriptId"])
          .sort((a, b) => Number(a["chunkIdx"]) - Number(b["chunkIdx"])),
      ),
    },
    job: {
      findMany: vi.fn(async (args: { where: Row }) =>
        t.jobs
          .filter((job) => matches(job, args.where))
          .sort((a, b) => (b["queuedAt"] as Date).getTime() - (a["queuedAt"] as Date).getTime()),
      ),
      /** `orderBy: { queuedAt: "desc" }`, as the face-detection lookup asks. */
      findFirst: vi.fn(
        async (args: { where: Row }) =>
          t.jobs
            .filter((job) => matches(job, args.where))
            .sort(
              (a, b) => (b["queuedAt"] as Date).getTime() - (a["queuedAt"] as Date).getTime(),
            )[0] ?? null,
      ),
    },
  };
}

function laneFull(): AppException {
  return new AppException(JOB_ERROR_CODES.concurrencyCap, "lane full", 429, {
    retryAfterSeconds: 30,
  });
}

function word(wid: string, s: number, e: number, t: string): Row {
  return { wid, s, e, t };
}

interface Harness {
  service: RepurposeClipsService;
  tables: Tables;
  enqueue: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  maybeEnqueueFaces: ReturnType<typeof vi.fn>;
  derivedHead: ReturnType<typeof vi.fn>;
  derivedGet: ReturnType<typeof vi.fn>;
  /** `prisma.job.findFirst`: the source's face-detection lookup. */
  jobFindFirst: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  env: { FEATURE_FLAGS_JSON: Record<string, boolean> };
  /** What `jobs.enqueue` does next: `ok`, lane full, or throw this error. */
  enqueueMode: { next: "ok" | "lane" | Error };
}

function harness(overrides: { run?: Row; media?: Row } = {}): Harness {
  const tables: Tables = {
    runs: [
      {
        id: RUN,
        workspaceId: WS,
        sourceProjectId: SRC,
        status: "candidates_ready",
        currentStage: "finding_clips",
        progress: 55,
        failureCode: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...overrides.run,
      },
    ],
    candidates: [
      { id: CAND_A, runId: RUN, source: "ai", startMs: 60_000, endMs: 90_000, title: "A moment" },
      { id: CAND_B, runId: RUN, source: "ai", startMs: 120_000, endMs: 150_000, title: "Another" },
    ],
    clips: [],
    variants: [],
    media: [
      {
        id: MEDIA,
        projectId: SRC,
        role: "primary",
        status: "ready",
        bucket: "s3",
        storageKey: `ws/${WS}/p/${SRC}/media/${MEDIA}/raw.mp4`,
        durationMs: 600_000,
        facesKey: null,
        rawPurgedAt: null,
        ...overrides.media,
      },
    ],
    transcripts: [{ id: TR, projectId: SRC }],
    chunks: [
      {
        transcriptId: TR,
        chunkIdx: 0,
        revision: 1,
        words: [
          word("0:0", 59_000, 59_900, "before"),
          word("0:1", 60_100, 60_400, "the"),
          word("0:2", 60_500, 61_000, "point"),
          word("0:3", 89_000, 89_900, "lands"),
          word("0:4", 91_000, 91_500, "after"),
        ],
      },
    ],
    jobs: [],
  };
  const prisma = fakePrisma(tables);

  const enqueueMode: Harness["enqueueMode"] = { next: "ok" };
  const enqueue = vi.fn(async (input: { jobKey: string; params: Row }) => {
    const mode = enqueueMode.next;
    if (mode === "lane") throw laneFull();
    if (mode instanceof Error) throw mode;
    const live = tables.jobs.find(
      (job) =>
        job["jobKey"] === input.jobKey && ["queued", "running"].includes(String(job["status"])),
    );
    if (live !== undefined) return { job: live, deduplicated: true };
    const job = {
      id: `01JCJ0B${String(clock).padStart(19, "0")}`,
      workspaceId: WS,
      type: "media.clip",
      jobKey: input.jobKey,
      status: "queued",
      error: null,
      params: input.params,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      maxQueueWaitMs: 30 * 60_000,
    };
    clock++;
    tables.jobs.push(job);
    return { job, deduplicated: false };
  });
  const cancel = vi.fn(async (jobId: string) => {
    const job = tables.jobs.find((row) => row["id"] === jobId);
    if (job === undefined) throw new Error("no such job");
    Object.assign(job, {
      status: "cancelled",
      finishedAt: new Date(),
      error: { code: "jobs/cancelled", message: "x", retryable: false },
    });
    return job;
  });
  const maybeEnqueueFaces = vi.fn(async () => undefined);
  const derivedHead = vi.fn(async () => ({ sizeBytes: 1_024 }));
  const derivedGet = vi.fn(async () => Buffer.from("{}"));
  const consume = vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSec: 0 }));
  const publish = vi.fn(async () => undefined);
  const env = { FEATURE_FLAGS_JSON: {} as Record<string, boolean> };

  const service = new RepurposeClipsService(
    // The fake reads `tables` through closures, so later pushes are seen.
    prisma as never,
    { enqueue, cancel } as never,
    {
      forWorkspace: vi.fn(async () => ({ entitlements: { flags: { repurpose_flow: true } } })),
    } as never,
    { publish } as never,
    { record: vi.fn(async () => undefined) } as never,
    { maybeEnqueue: maybeEnqueueFaces } as never,
    { consume } as never,
    env as unknown as Env,
    {
      presignGet: vi.fn(async (key: string) => `https://cdn.example.test/${key}`),
      head: derivedHead,
      get: derivedGet,
    } as never,
  );
  return {
    service,
    tables,
    enqueue,
    cancel,
    maybeEnqueueFaces,
    derivedHead,
    derivedGet,
    jobFindFirst: prisma.job.findFirst,
    consume,
    publish,
    env,
    enqueueMode,
  };
}

function clipRow(candidateId: string, overrides: Row = {}): Row {
  const candidate =
    candidateId === CAND_A ? { start: 60_000, end: 90_000 } : { start: 120_000, end: 150_000 };
  return {
    id: `01JCCX${candidateId.slice(6)}`,
    runId: RUN,
    candidateId,
    title: "A moment",
    sourceStartMs: candidate.start,
    sourceEndMs: candidate.end,
    mezzanineKey: null,
    mezzanineJobId: null,
    createdAt: new Date(clock++),
    ...overrides,
  };
}

/** A job queued a minute ago (in `clock` order), finished at once if it is over. */
function jobRow(
  candidateId: string,
  status: string,
  error: unknown = null,
  timings: Row = {},
): Row {
  const queuedAt = new Date(Date.now() - 60_000 + clock);
  const over = !["queued", "running"].includes(status);
  return {
    id: `01JCJ0B${String(clock++).padStart(19, "0")}`,
    workspaceId: WS,
    type: "media.clip",
    jobKey: `media.clip:${candidateId}:0-1:2`,
    status,
    error,
    queuedAt,
    startedAt: status === "queued" ? null : queuedAt,
    finishedAt: over ? queuedAt : null,
    maxQueueWaitMs: 30 * 60_000,
    ...timings,
  };
}

/**
 * An `ai.faces` job for the source media, queued `agoMs` ago and (unless it is
 * still queued) started `startedAgoMs` ago — at once, by default.
 */
function facesJob(status: string, agoMs = 0, startedAgoMs = agoMs): Row {
  const queuedAt = new Date(Date.now() - agoMs);
  const startedAt = new Date(Date.now() - startedAgoMs);
  return {
    id: `01JCFACES${String(clock++).padStart(17, "0")}`,
    workspaceId: WS,
    type: "ai.faces",
    jobKey: facesJobKey(MEDIA),
    status,
    error: null,
    queuedAt,
    startedAt: status === "queued" ? null : startedAt,
    finishedAt: ["queued", "running"].includes(status) ? null : startedAt,
  };
}

/** Detection is queued the first time it is asked for, as `FacesTrigger.maybeEnqueue` does. */
function detectionQueues(h: Harness): void {
  h.maybeEnqueueFaces.mockImplementation(async () => {
    if (h.tables.jobs.some((job) => job["type"] === "ai.faces")) return undefined;
    const job = facesJob("queued");
    h.tables.jobs.push(job);
    return { jobId: job["id"] };
  });
}

/**
 * The source's face track lands: its job succeeds, the media row gets the key,
 * and the file shows one speaker centred at 0.72 across the first 160 s.
 */
function trackLands(h: Harness): void {
  for (const job of h.tables.jobs) {
    if (job["type"] === "ai.faces")
      Object.assign(job, { status: "succeeded", finishedAt: new Date() });
  }
  const source = h.tables.media.find((row) => row["id"] === MEDIA);
  if (source !== undefined) source["facesKey"] = FACES_KEY;
  h.derivedGet.mockResolvedValue(
    Buffer.from(
      JSON.stringify({
        version: 1,
        intervalMs: 250,
        source: { width: 1920, height: 1080 },
        samples: Array.from({ length: 640 }, (_, i) => [i * 250, [[0.62, 0.2, 0.2, 0.2]]]),
      }),
    ),
  );
}

/** Every `media.clip` payload enqueued so far, checked against the contract. */
function enqueuedPayloads(h: Harness) {
  return h.enqueue.mock.calls.map((call) =>
    MediaClipPayloadSchema.parse((call[0] as { params: unknown }).params),
  );
}

/** The 9:16 variant of `clip`, whose child project's primary media is `media`. */
function childOf(h: Harness, clip: Row, media: Row, profileVersion = CLIP_PROFILE_VERSION): void {
  const projectId = `01JCCH1LD${String(clip["id"]).slice(9)}`;
  h.tables.variants.push({ clipId: clip["id"], aspect: "r9x16", profileVersion, projectId });
  h.tables.media.push({
    id: `01JCCH1LDMED1A${String(clip["id"]).slice(14)}`,
    projectId,
    role: "primary",
    failureReason: null,
    createdAt: new Date(clock++),
    ...media,
  });
}

/** The payload of the first `media.clip` enqueued, checked against the contract. */
function enqueuedPayload(h: Harness) {
  const input = h.enqueue.mock.calls.at(0)?.[0] as { params: unknown } | undefined;
  return MediaClipPayloadSchema.parse(input?.params);
}

async function expectCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).code).toBe(code);
  if (status !== undefined) expect((error as AppException).httpStatus).toBe(status);
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("createClip", () => {
  it("cuts a new moment: a 1080 x 1920 picture under the source project, parsed against the contract", async () => {
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(clip.state).toBe("cutting");
    expect(clip.failureCode).toBeNull();
    const payload = enqueuedPayload(h);
    expect(payload.profile.maxHeight).toBe(1920);
    expect(payload.destination.key).toBe(
      clipMasterKey({ workspaceId: WS, sourceProjectId: SRC, runId: RUN, candidateId: CAND_A }),
    );
    expect(payload.source.key).toBe(`ws/${WS}/p/${SRC}/media/${MEDIA}/raw.mp4`);
    expect(payload.profileVersion).toBe(CLIP_PROFILE_VERSION);
    // No face track, and no detection on its way (this source cannot have one
    // queued): centre at once, and detection asked for — once.
    expect(payload.reframe).toEqual({ centerX: 0.5, basis: "centre" });
    expect(h.maybeEnqueueFaces).toHaveBeenCalledWith(MEDIA, { onlyIfNeverTried: true });
    // The run starts showing "Creating your clips".
    expect(h.tables.runs[0]?.["status"]).toBe("materializing");
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("frames the cut on the speaker the source's face track shows", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    const samples = Array.from({ length: 140 }, (_, i) => [
      59_000 + i * 250,
      [[0.62, 0.2, 0.2, 0.2]],
    ]);
    h.derivedGet.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          version: 1,
          intervalMs: 250,
          source: { width: 1920, height: 1080 },
          samples,
        }),
      ),
    );

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(h.derivedGet).toHaveBeenCalledWith(FACES_KEY);
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.72, basis: "faces" });
    expect(h.maybeEnqueueFaces).not.toHaveBeenCalled();
  });

  it("keeps a clip asked for while the plan's lane is full, waiting, instead of failing", async () => {
    // The live run of 2026-09-19: three of five clips refused with 429 and
    // orphaned on "Cutting the 9:16 clip…" forever.
    h.enqueueMode.next = "lane";
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(clip.state).toBe("waiting");
    expect(h.tables.clips).toHaveLength(1);
    expect(h.tables.runs[0]?.["status"]).toBe("materializing");
  });

  it("removes a clip it created when the cut is refused for any other reason", async () => {
    h.enqueueMode.next = new Error("queue unavailable");
    await expect(h.service.createClip(WS, USER, RUN, { candidateId: CAND_A })).rejects.toThrow(
      "queue unavailable",
    );
    expect(h.tables.clips).toHaveLength(0);
    expect(h.tables.runs[0]?.["status"]).toBe("candidates_ready");
  });

  it("refuses a cancelled run, or one with no moments, before writing anything", async () => {
    h = harness({ run: { status: "cancelled" } });
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      REPURPOSE_CLIP_ERRORS.runNotReady,
      409,
    );

    h = harness({ run: { status: "failed", failureCode: "repurpose/source_unavailable" } });
    h.tables.candidates.length = 0;
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      REPURPOSE_CLIP_ERRORS.runNotReady,
      409,
    );
    expect(h.tables.clips).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("answers 404 for a moment that is not this run's", async () => {
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: "01JCN0TAM0MENT000000000000" }),
      "repurpose/not_found",
      404,
    );
  });

  it("refuses to cut from a source whose original has been purged, and says so", async () => {
    h = harness({ media: { rawPurgedAt: new Date(0) } });
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      REPURPOSE_CLIP_ERRORS.sourceExpired,
      409,
    );
    expect(h.tables.clips).toHaveLength(0);
  });

  it("does not cut again a clip that is already being cut", async () => {
    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    const again = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(again.state).toBe("cutting");
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.consume).toHaveBeenCalledTimes(1);
  });

  it("re-cuts a ready clip made at an older profile, and leaves one made at this profile", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    h.tables.variants.push({
      clipId: ready["id"],
      aspect: "r9x16",
      profileVersion: CLIP_PROFILE_VERSION,
    });
    const current = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(current.state).toBe("ready");
    expect(h.enqueue).not.toHaveBeenCalled();

    h.tables.variants.splice(0, 1, { clipId: ready["id"], aspect: "r9x16", profileVersion: "1" });
    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    // A re-cut is never undone: the clip keeps its picture if the cut is refused.
    expect(h.tables.clips).toHaveLength(1);
  });

  it("cuts again a ready clip whose child project's media failed", async () => {
    // CLAUDE.md §13's repair path: the handler re-runs probe and proxy for a
    // child whose media failed, but only a new cut ever reaches it.
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    childOf(h, ready, { status: "failed", failureReason: "media/probe_failed" });
    h.tables.jobs.push(jobRow(CAND_A, "succeeded"));

    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(clip.state).toBe("cutting");
  });

  it("keeps a failed clip asked for again while the lane is full waiting, and owed", async () => {
    const failed = clipRow(CAND_A);
    h.tables.clips.push(failed);
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/corrupt" }));
    h.enqueueMode.next = "lane";

    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("waiting");

    h.enqueueMode.next = "ok";
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([failed["id"]]);
  });

  it("does not lose a re-cut the lane refused", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    childOf(h, ready, { status: "ready" }, "1");
    h.tables.jobs.push(jobRow(CAND_A, "succeeded"));
    h.enqueueMode.next = "lane";

    // The old picture is still there to watch while the new one is owed.
    expect((await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A })).state).toBe(
      "ready",
    );

    h.enqueueMode.next = "ok";
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([ready["id"]]);
    // Once it is on its way, nothing is owed any more.
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([]);
  });

  it("never re-cuts a ready clip at an older profile that nobody asked to re-cut", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    childOf(h, ready, { status: "ready" }, "1");
    h.tables.jobs.push(jobRow(CAND_A, "succeeded"));
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([]);
  });

  it("cancels a cut that stalled before cutting the clip again", async () => {
    // A lost worker leaves the job `running`, and the new enqueue would dedupe
    // onto it; production runs no queue-timeout task to end it.
    const stuck = clipRow(CAND_A);
    h.tables.clips.push(stuck);
    const job = jobRow(CAND_A, "running", null, {
      queuedAt: new Date(Date.now() - 3 * 3_600_000),
      startedAt: new Date(Date.now() - 3 * 3_600_000),
    });
    h.tables.jobs.push(job);

    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.cancel).toHaveBeenCalledWith(job["id"], WS);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(clip.state).toBe("cutting");
  });

  it("does not remove a clip a concurrent request has started cutting", async () => {
    // Request A made the row; B reused it and enqueued; A's own enqueue then
    // failed. Deleting would leave B's answer, and B's cut, pointing at nothing.
    h.enqueue.mockImplementationOnce(async () => {
      h.tables.jobs.push(jobRow(CAND_A, "queued"));
      throw new Error("queue unavailable");
    });
    await expect(h.service.createClip(WS, USER, RUN, { candidateId: CAND_A })).rejects.toThrow(
      "queue unavailable",
    );
    expect(h.tables.clips).toHaveLength(1);
  });

  it("does not remove a clip a concurrent request was told is waiting", async () => {
    h.enqueue.mockImplementationOnce(async () => {
      const row = h.tables.clips[0];
      if (row !== undefined) row["updatedAt"] = new Date();
      throw new Error("queue unavailable");
    });
    await expect(h.service.createClip(WS, USER, RUN, { candidateId: CAND_A })).rejects.toThrow(
      "queue unavailable",
    );
    expect(h.tables.clips).toHaveLength(1);
  });

  it("reopens a run whose discovery failed, once a clip is cut from it", async () => {
    h = harness({ run: { status: "failed", failureCode: "repurpose/stage_timeout" } });
    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.tables.runs[0]).toMatchObject({
      status: "materializing",
      failureCode: null,
      completedAt: null,
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("frames on the centre when the face track is garbage, rather than failing the cut", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    h.derivedGet.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          version: 1,
          intervalMs: 250,
          source: { width: 1920, height: 1080 },
          // A string coordinate made the centre NaN, and the payload refused it.
          samples: [[60_000, [["0.6", 0.2, 0.2, 0.2]]]],
        }),
      ),
    );
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("cutting");
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });

  it("stops the cut where the video stops", async () => {
    h.tables.candidates[0] = { ...h.tables.candidates[0], startMs: 580_000, endMs: 600_400 };
    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(enqueuedPayload(h).endMs).toBe(600_000);
  });

  it("is limited per run, so a runaway tab cannot queue hundreds of cuts", async () => {
    h.consume.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSec: 12 });
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      "common/rate_limited",
      429,
    );
    expect(h.tables.clips).toHaveLength(0);
  });

  it("answers 404 while the surface is switched off", async () => {
    h.env.FEATURE_FLAGS_JSON["repurpose_flow"] = false;
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      "repurpose/not_available",
      404,
    );
  });
});

describe("retryClip", () => {
  it("cuts a failed clip again", async () => {
    const failed = clipRow(CAND_A);
    h.tables.clips.push(failed);
    h.tables.jobs.push(
      jobRow(CAND_A, "failed", { code: "media/corrupt", message: "x", retryable: false }),
    );

    const retried = await h.service.retryClip(WS, USER, RUN, String(failed["id"]));
    expect(retried.state).toBe("cutting");
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("nudges a waiting clip, and a lane that is still full leaves it waiting, not failed", async () => {
    const waiting = clipRow(CAND_A);
    h.tables.clips.push(waiting);
    h.enqueueMode.next = "lane";
    const retried = await h.service.retryClip(WS, USER, RUN, String(waiting["id"]));
    expect(retried.state).toBe("waiting");
  });

  it("keeps a failed clip retried while the lane is full waiting, and the reconcile cuts it", async () => {
    // Before, the response said "failed", nothing was recorded, and the
    // reconcile only looked for clips with no job at all: the retry vanished.
    const failed = clipRow(CAND_A);
    h.tables.clips.push(failed);
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/encode_failed" }));
    h.enqueueMode.next = "lane";

    const retried = await h.service.retryClip(WS, USER, RUN, String(failed["id"]));
    expect(retried).toMatchObject({ state: "waiting", failureCode: null });
    expect((await h.service.listClips(WS, RUN)).clips[0]?.state).toBe("waiting");

    h.enqueueMode.next = "ok";
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([failed["id"]]);
    expect((await h.service.listClips(WS, RUN)).clips[0]?.state).toBe("cutting");
  });

  it("cuts again a clip whose child project's media failed", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    childOf(h, ready, { status: "failed", failureReason: "media/probe_failed" });
    h.tables.jobs.push(jobRow(CAND_A, "succeeded"));

    const retried = await h.service.retryClip(WS, USER, RUN, String(ready["id"]));
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(retried.state).toBe("cutting");
  });

  it("cancels a stalled cut and cuts again", async () => {
    const stuck = clipRow(CAND_A);
    h.tables.clips.push(stuck);
    const job = jobRow(CAND_A, "queued", null, {
      queuedAt: new Date(Date.now() - 31 * 60_000),
    });
    h.tables.jobs.push(job);

    const retried = await h.service.retryClip(WS, USER, RUN, String(stuck["id"]));
    expect(h.cancel).toHaveBeenCalledWith(job["id"], WS);
    expect(retried.state).toBe("cutting");
  });

  it("refuses a clip that is ready or being cut", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    const cutting = clipRow(CAND_B);
    h.tables.clips.push(ready, cutting);
    h.tables.jobs.push(jobRow(CAND_B, "running"));

    await expectCode(
      h.service.retryClip(WS, USER, RUN, String(ready["id"])),
      REPURPOSE_CLIP_ERRORS.clipNotRetryable,
      409,
    );
    await expectCode(
      h.service.retryClip(WS, USER, RUN, String(cutting["id"])),
      REPURPOSE_CLIP_ERRORS.clipNotRetryable,
      409,
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("listClips", () => {
  it("keeps every existing field and adds each clip's state and failure code", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    const failed = clipRow(CAND_B);
    h.tables.clips.push(ready, failed);
    h.tables.jobs.push(jobRow(CAND_B, "failed", { code: "media/corrupt" }));

    const { clips } = await h.service.listClips(WS, RUN);
    expect(clips.map((clip) => [clip.state, clip.failureCode])).toEqual([
      ["ready", null],
      ["failed", "media/corrupt"],
    ]);
    expect(clips[0]).toMatchObject({
      id: ready["id"],
      candidateId: CAND_A,
      title: "A moment",
      mezzanineKey: "ws/master.mp4",
      mezzanineUrl: "https://cdn.example.test/ws/master.mp4",
      variants: [],
      candidate: expect.objectContaining({ id: CAND_A }),
    });
    // A failed clip is never retried behind the person's back.
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("enqueues a waiting clip as soon as the lane has room, from the page's own polling", async () => {
    h.tables.clips.push(clipRow(CAND_A));
    const { clips } = await h.service.listClips(WS, RUN);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(clips[0]?.state).toBe("cutting");
  });

  it("shows a waiting clip whose source was purged as failed, and stops trying to cut it", async () => {
    h = harness({ media: { rawPurgedAt: new Date(0) } });
    h.tables.clips.push(clipRow(CAND_A));
    const { clips } = await h.service.listClips(WS, RUN);
    expect(clips[0]).toMatchObject({
      state: "failed",
      failureCode: REPURPOSE_CLIP_ERRORS.sourceExpired,
    });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("shows a clip whose child media failed as failed, with the media's reason", async () => {
    const ready = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(ready);
    childOf(h, ready, { status: "failed", failureReason: "media/probe_failed" });
    h.tables.jobs.push(jobRow(CAND_A, "succeeded"));

    const { clips } = await h.service.listClips(WS, RUN);
    expect(clips[0]).toMatchObject({ state: "failed", failureCode: "media/probe_failed" });
    // Still the person's to retry, never re-cut behind their back.
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("does not knock on a full lane on every poll", async () => {
    h.tables.clips.push(clipRow(CAND_A));
    h.enqueueMode.next = "lane";
    await h.service.listClips(WS, RUN);
    await h.service.listClips(WS, RUN);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileClips", () => {
  it("stops at the first lane refusal and keeps the rest in their place", async () => {
    h.tables.clips.push(clipRow(CAND_A), clipRow(CAND_B));
    h.enqueueMode.next = "lane";
    expect(await h.service.reconcileClips(RUN)).toEqual({ enqueued: [] });
    expect(h.enqueue).toHaveBeenCalledTimes(1);

    h.enqueueMode.next = "ok";
    const { enqueued } = await h.service.reconcileClips(RUN);
    expect(enqueued).toHaveLength(2);
  });

  it("reads the source's face track once, not on every pass the lane refuses", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    h.derivedGet.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          version: 1,
          intervalMs: 250,
          source: { width: 1920, height: 1080 },
          samples: [[60_000, [[0.6, 0.2, 0.2, 0.2]]]],
        }),
      ),
    );
    h.tables.clips.push(clipRow(CAND_A), clipRow(CAND_B));
    h.enqueueMode.next = "lane";
    await h.service.reconcileClips(RUN);
    await h.service.reconcileClips(RUN);
    h.enqueueMode.next = "ok";
    const { enqueued } = await h.service.reconcileClips(RUN);

    expect(enqueued).toHaveLength(2);
    expect(h.derivedGet).toHaveBeenCalledTimes(1);
  });

  it("never enqueues for a cancelled run", async () => {
    h = harness({ run: { status: "cancelled" } });
    h.tables.clips.push(clipRow(CAND_A));
    expect(await h.service.reconcileClips(RUN)).toEqual({ enqueued: [] });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("moves a materializing run on once its clips are all done", async () => {
    h = harness({ run: { status: "materializing", currentStage: "styles_formats" } });
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));
    await h.service.reconcileClips(RUN);
    expect(h.tables.runs[0]?.["status"]).toBe("review_ready");
    expect(h.publish).toHaveBeenCalledTimes(1);
  });
});

describe("a source whose face track is still being made", () => {
  // Found on the deploy of 2026-09-26: no source proxied before `ai.faces` had a
  // track, the first reconcile queued detection and cut every waiting clip on
  // the centre in the same breath, and a clip ready at the current profile is
  // never re-framed.
  it("holds a new clip, waiting, instead of cutting it on the centre for good, then frames it", async () => {
    detectionQueues(h);
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(clip.state).toBe("waiting");
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.maybeEnqueueFaces).toHaveBeenCalledWith(MEDIA, { onlyIfNeverTried: true });
    // It is the run's clip all the same, and the run says it is making it.
    expect(h.tables.clips).toHaveLength(1);
    expect(h.tables.runs[0]?.["status"]).toBe("materializing");

    trackLands(h);
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([clip.id]);
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.72, basis: "faces" });
  });

  it("cuts none of a run's waiting clips while detection runs, and all of them on the track after", async () => {
    // The three legacy clips of run 01M2W1J5BZJF7QGMDM5HE39YZ1: rows, no jobs.
    detectionQueues(h);
    h.tables.clips.push(clipRow(CAND_A), clipRow(CAND_B));

    expect(await h.service.reconcileClips(RUN)).toEqual({ enqueued: [] });
    expect(await h.service.reconcileClips(RUN)).toEqual({ enqueued: [] });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect((await h.service.listClips(WS, RUN)).clips.map((clip) => clip.state)).toEqual([
      "waiting",
      "waiting",
    ]);

    trackLands(h);
    expect((await h.service.reconcileClips(RUN)).enqueued).toHaveLength(2);
    expect(enqueuedPayloads(h).map((payload) => payload.reframe)).toEqual([
      { centerX: 0.72, basis: "faces" },
      { centerX: 0.72, basis: "faces" },
    ]);
  });

  it("keeps a retry that waits for the track owed, so the reconcile cuts it", async () => {
    const failed = clipRow(CAND_A);
    h.tables.clips.push(failed);
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/corrupt" }));
    detectionQueues(h);

    const retried = await h.service.retryClip(WS, USER, RUN, String(failed["id"]));
    expect(retried).toMatchObject({ state: "waiting", failureCode: null });
    expect(h.enqueue).not.toHaveBeenCalled();

    trackLands(h);
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([failed["id"]]);
    expect(enqueuedPayload(h).reframe).toMatchObject({ basis: "faces" });
  });

  it("cuts on the centre once detection has failed", async () => {
    h.tables.jobs.push(facesJob("failed"));
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("cutting");
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });

  it("cuts on the centre once detection has been at it for the whole wait", async () => {
    // A stuck worker-ai costs the framing, never the clip. The fixture source
    // is ten minutes long, so detection is given half that to run.
    h.tables.jobs.push(facesJob("running", faceDetectionRunWaitMs(600_000) + 1_000));
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("cutting");
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });

  it("still waits for a detection that queued behind others and has only just started", async () => {
    // worker-ai detects one video at a time. Timed from queueing, the wait was
    // spent in the queue and the clip was cut on the centre for good the moment
    // detection finally began.
    detectionQueues(h);
    h.tables.jobs.push(facesJob("running", FACE_TRACK_WAIT_MS + 60_000, 30_000));
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("waiting");
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.jobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { status: true, queuedAt: true, startedAt: true, finishedAt: true },
      }),
    );

    trackLands(h);
    expect((await h.service.reconcileClips(RUN)).enqueued).toEqual([clip.id]);
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.72, basis: "faces" });
  });

  // The lookup only decides framing, so a database that fails it must cost the
  // framing, not the clip: holding the cut would leave it waiting for a job
  // nobody can see, and a throw would fail the person's request (or skip the
  // reconcile's clip) over a question that was never about the clip itself.
  function detectionLookupFails(): void {
    h.jobFindFirst.mockImplementation(async (args: { where: Row }) => {
      if (args.where["type"] === "ai.faces") throw new Error("connection reset");
      return null;
    });
  }

  it("cuts a new clip on the centre when the detection lookup fails, instead of holding or refusing it", async () => {
    detectionQueues(h);
    detectionLookupFails();
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(h.jobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: "ai.faces", jobKey: facesJobKey(MEDIA) } }),
    );
    expect(clip.state).toBe("cutting");
    expect(h.tables.clips).toHaveLength(1);
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });

  it("cuts a run's waiting clips on the centre when the detection lookup fails, instead of skipping them", async () => {
    detectionQueues(h);
    detectionLookupFails();
    h.tables.clips.push(clipRow(CAND_A), clipRow(CAND_B));

    expect((await h.service.reconcileClips(RUN)).enqueued).toHaveLength(2);
    expect(enqueuedPayloads(h).map((payload) => payload.reframe)).toEqual([
      { centerX: 0.5, basis: "centre" },
      { centerX: 0.5, basis: "centre" },
    ]);
  });

  it("frames on the centre, without downloading it, a face track over the size bound", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    h.derivedHead.mockResolvedValue({ sizeBytes: 65 * 1024 * 1024 });
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(clip.state).toBe("cutting");
    expect(h.derivedGet).not.toHaveBeenCalled();
    expect(enqueuedPayload(h).reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });
});

describe("addManualCandidate", () => {
  it("adds a moment by time: unranked, unscored, with what is said in it", async () => {
    const candidate = await h.service.addManualCandidate(WS, USER, RUN, {
      startMs: 60_050,
      endMs: 90_000,
    });
    expect(candidate).toMatchObject({
      runId: RUN,
      source: "manual",
      state: "proposed",
      rank: null,
      startMs: 60_050,
      endMs: 90_000,
      title: "Moment at 1:00–1:30",
      transcriptExcerpt: "the point lands",
    });
  });

  it("keeps the person's own title, and rounds a fractional time", async () => {
    const candidate = await h.service.addManualCandidate(WS, USER, RUN, {
      startMs: 10_000.4,
      endMs: 20_000.6,
      title: "The bit about bees",
    });
    expect(candidate).toMatchObject({
      startMs: 10_000,
      endMs: 20_001,
      title: "The bit about bees",
    });
  });

  it("refuses a moment outside 3 s to 3 min, or outside the video, with its own code", async () => {
    for (const [startMs, endMs] of [
      [60_000, 62_999], // too short
      [0, 180_001], // too long
      [-1, 10_000], // before the start
      [590_000, 600_001], // past the end
      [30_000, 30_000], // empty
    ] as const) {
      await expectCode(
        h.service.addManualCandidate(WS, USER, RUN, { startMs, endMs }),
        REPURPOSE_CLIP_ERRORS.boundsInvalid,
        400,
      );
    }
    expect(h.tables.candidates).toHaveLength(2);
  });

  it("treats the same bounds twice as one moment", async () => {
    const first = await h.service.addManualCandidate(WS, USER, RUN, {
      startMs: 1_000,
      endMs: 9_000,
    });
    const second = await h.service.addManualCandidate(WS, USER, RUN, {
      startMs: 1_000,
      endMs: 9_000,
    });
    expect(second.id).toBe(first.id);
    expect(h.tables.candidates).toHaveLength(3);
  });

  it("is open after highlight discovery failed, and gives the run its moments back", async () => {
    // Left failed, the run would say so for good while the person cut clips
    // from it: nothing a clip does ever moves a failed run.
    h = harness({
      run: {
        status: "failed",
        failureCode: "repurpose/highlights_failed",
        completedAt: new Date(0),
      },
    });
    const candidate = await h.service.addManualCandidate(WS, USER, RUN, {
      startMs: 1_000,
      endMs: 9_000,
    });
    expect(candidate.source).toBe("manual");
    expect(h.tables.runs[0]).toMatchObject({
      status: "candidates_ready",
      failureCode: null,
      completedAt: null,
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("leaves a run that is not failed where it is", async () => {
    h = harness({ run: { status: "analyzing" } });
    await h.service.addManualCandidate(WS, USER, RUN, { startMs: 1_000, endMs: 9_000 });
    expect(h.tables.runs[0]?.["status"]).toBe("analyzing");
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("waits for the transcript, and is closed on a run that stopped before it", async () => {
    h = harness({ run: { status: "failed", failureCode: "repurpose/source_unavailable" } });
    await expectCode(
      h.service.addManualCandidate(WS, USER, RUN, { startMs: 1_000, endMs: 9_000 }),
      REPURPOSE_CLIP_ERRORS.runNotReady,
      409,
    );

    h = harness({ run: { status: "cancelled" } });
    await expectCode(
      h.service.addManualCandidate(WS, USER, RUN, { startMs: 1_000, endMs: 9_000 }),
      REPURPOSE_CLIP_ERRORS.runNotReady,
      409,
    );

    h = harness({ run: { status: "analyzing" } });
    h.tables.transcripts.length = 0;
    await expectCode(
      h.service.addManualCandidate(WS, USER, RUN, { startMs: 1_000, endMs: 9_000 }),
      REPURPOSE_CLIP_ERRORS.runNotReady,
      409,
    );
  });
});

describe("timecode", () => {
  it("writes minutes and seconds, and hours only when there are some", () => {
    expect(timecode(0)).toBe("0:00");
    expect(timecode(83_000)).toBe("1:23");
    expect(timecode(3_723_000)).toBe("1:02:03");
  });
});
