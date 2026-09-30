import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";
import {
  applyOps,
  DEFAULT_BRAND_KIT_SETTINGS,
  fromProjection,
  newId,
  toProjection,
  type EdgState,
} from "@montaj/edg";
import type { EdgOp, Pass, WordId } from "@montaj/edg/schemas";
import { clipMasterKey, MediaClipPayloadSchema } from "@montaj/repurpose-contracts";

import { ClipFinishing, HOOK_TITLE_MS } from "./clip-finishing.js";
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
  /** Clip projects' editing documents (`revision`, `updatedAt`). */
  docs: Row[];
  exports: Row[];
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
      const operator = condition as { startsWith?: string; in?: unknown[]; not?: unknown };
      if ("not" in operator) {
        if (value === operator.not) return false;
        continue;
      }
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
              project: {
                mediaAssets: t.media.filter((m) => m["projectId"] === v["projectId"]),
                exports: t.exports.filter((e) => e["projectId"] === v["projectId"]).reverse(),
              },
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
      findMany: vi.fn(async (args: { where: Row }) =>
        t.candidates.filter((c) => matches(c, args.where)),
      ),
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
    clipVariant: {
      findFirst: vi.fn(findOne(t.variants)),
      /** `captionClips`' read: a ready clip's 9:16 variant, its export and its project. */
      findMany: vi.fn(async () =>
        t.variants
          .filter((v) => t.clips.some((c) => c["id"] === v["clipId"] && c["mezzanineKey"] !== null))
          .map((v) => ({
            editFingerprint: "",
            status: "ready",
            latestExportId: null,
            ...v,
            latestExport: t.exports.find((e) => e["id"] === v["latestExportId"]) ?? null,
            project: {
              edgDocument: t.docs.find((d) => d["projectId"] === v["projectId"]) ?? null,
              mediaAssets: [...t.media]
                .reverse()
                .filter((m) => m["projectId"] === v["projectId"] && m["role"] === "primary")
                .slice(0, 1),
            },
          })),
      ),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        const variant = t.variants.find((v) => v["id"] === args.where["id"]);
        if (variant === undefined) throw new Error("no such variant");
        return Object.assign(variant, args.data);
      }),
    },
    export: {
      count: vi.fn(
        async (args: { where: Row }) => t.exports.filter((e) => matches(e, args.where)).length,
      ),
      findMany: vi.fn(async (args: { where: Row }) =>
        t.exports.filter((e) => matches(e, args.where)),
      ),
      update: vi.fn(async (args: { where: Row; data: Row }) => {
        const row = t.exports.find((e) => e["id"] === args.where["id"]);
        if (row === undefined) throw new Error("no such export");
        return Object.assign(row, args.data);
      }),
    },
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
      count: vi.fn(
        async (args: { where: Row }) => t.jobs.filter((job) => matches(job, args.where)).length,
      ),
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
  requestExport: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  maybeEnqueueFaces: ReturnType<typeof vi.fn>;
  derivedHead: ReturnType<typeof vi.fn>;
  derivedGet: ReturnType<typeof vi.fn>;
  derivedDelete: ReturnType<typeof vi.fn>;
  /** `prisma.job.findFirst`: the source's face-detection lookup. */
  jobFindFirst: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  env: { FEATURE_FLAGS_JSON: Record<string, boolean> };
  /** What `jobs.enqueue` does next: `ok`, lane full, or throw this error. */
  enqueueMode: { next: "ok" | "lane" | Error };
  /** The fake Prisma itself, for a test that wires more of the app onto it. */
  prisma: ReturnType<typeof fakePrisma>;
}

function harness(
  overrides: {
    run?: Row;
    media?: Row;
    finishing?: unknown;
    probeRestart?: unknown;
    brandKits?: unknown;
  } = {},
): Harness {
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
    docs: [],
    exports: [],
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
  const derivedDelete = vi.fn(async () => undefined);
  const consume = vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterSec: 0 }));
  const publish = vi.fn(async () => undefined);
  const env = { FEATURE_FLAGS_JSON: {} as Record<string, boolean> };
  const requestExport = vi.fn(async () => ({
    exportId: `01JCEXP${String(clock++).padStart(19, "0")}`,
  }));

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
      delete: derivedDelete,
    } as never,
    { requestExport } as never,
    overrides.finishing as never,
    overrides.probeRestart as never,
    undefined,
    undefined,
    overrides.brandKits as never,
  );
  // Plenty of disk unless a test says otherwise.
  service.freeBytes = async () => Number.POSITIVE_INFINITY;
  return {
    service,
    tables,
    requestExport,
    enqueue,
    cancel,
    maybeEnqueueFaces,
    derivedHead,
    derivedGet,
    derivedDelete,
    jobFindFirst: prisma.job.findFirst,
    consume,
    publish,
    env,
    enqueueMode,
    prisma,
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
    expect(enqueuedPayload(h).reframe).toMatchObject({ centerX: 0.72, basis: "faces" });
    expect(h.maybeEnqueueFaces).not.toHaveBeenCalled();
  });

  it("starts the clip from its moment's copy, the words to post it with (2026-09-29)", async () => {
    const copy = {
      summary: "Salary badhne par bhi paise kyun nahi bachte.",
      hook: "Yeh galti sab karte hain",
      cta: "Poora video zaroor dekhiye.",
      hashtags: ["#money", "#paisa"],
      locale: "hi-Latn",
      title: "Salary se ameer kyun nahi bante?",
      source: "model",
    };
    const moment = h.tables.candidates.find((row) => row["id"] === CAND_A);
    if (moment !== undefined) moment["copy"] = copy;

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(h.tables.clips.find((row) => row["candidateId"] === CAND_A)?.["copy"]).toEqual(copy);
  });

  it("starts a clip with no copy when its moment has none", async () => {
    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.tables.clips.find((row) => row["candidateId"] === CAND_A)).not.toHaveProperty("copy");
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

  it("keeps a clip asked for while the source is still being encoded waiting, not refused", async () => {
    // Moments can be ready before the video encode is (W5): this used to be a
    // 409 the page read as "This run was stopped".
    h = harness({ media: { status: "probing" } });
    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(clip.state).toBe("waiting");
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.tables.clips).toHaveLength(1);
    expect(h.tables.runs[0]?.["status"]).toBe("materializing");
  });

  it("refuses a source that failed its preparation with its own code, spending no budget", async () => {
    h = harness({ media: { status: "failed", failureReason: "media/corrupt" } });
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      REPURPOSE_CLIP_ERRORS.sourceFailed,
      409,
    );
    expect(h.tables.clips).toHaveLength(0);
    expect(h.consume).not.toHaveBeenCalled();
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

describe("audiograms: a source with no picture (2026-10-04)", () => {
  const AUDIO = {
    width: null,
    height: null,
    storageKey: `ws/${WS}/p/${SRC}/media/${MEDIA}/raw.mp3`,
  };
  const COVER_ID = "01JCC0VER00000000000000000";
  const LOGO_ID = "01JCL0G0000000000000000000";
  const cover = { key: `ws/${WS}/brand/${COVER_ID}.jpg`, format: "jpeg" as const };

  function brandKits(options: { cover?: boolean; kit?: boolean; throws?: boolean } = {}) {
    return {
      coverArtwork: vi.fn(async () => {
        if (options.throws === true) throw new Error("database down");
        return options.cover === false ? null : cover;
      }),
      forClips: vi.fn(async () =>
        options.kit === false
          ? null
          : {
              settings: {
                ...DEFAULT_BRAND_KIT_SETTINGS,
                colors: { primary: "#ffd400", secondary: "#102040", text: "#ffffff" },
              },
              logo: { assetId: LOGO_ID, format: "png", width: 400, height: 400 },
            },
      ),
      logoArtwork: vi.fn((workspaceId: string, logo: { assetId: string }) => ({
        key: `ws/${workspaceId}/brand/${logo.assetId}.png`,
        format: "png" as const,
      })),
    };
  }

  it("asks for a picture to be drawn, on the default colours, with the new profile", async () => {
    h = harness({ media: AUDIO });

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    const payload = enqueuedPayload(h);
    expect(payload.audiogram).toEqual({ background: "#141217", accent: "#f1ece6" });
    expect(payload.profileVersion).toBe("4");
    expect(CLIP_PROFILE_VERSION).toBe("4");
    const input = h.enqueue.mock.calls[0]?.[0] as { jobKey: string };
    expect(input.jobKey.endsWith(":4")).toBe(true);
    // Centred: a source with no picture has no face track to frame by.
    expect(payload.reframe).toEqual({ centerX: 0.5, basis: "centre" });
  });

  it("asks for nothing new for a source with a picture", async () => {
    h = harness({ media: { width: 1_920, height: 1_080 }, brandKits: brandKits() });

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(enqueuedPayload(h)).not.toHaveProperty("audiogram");
  });

  it("draws the run's cover on the brand kit's colours when the run uses the kit", async () => {
    const kits = brandKits();
    h = harness({
      media: AUDIO,
      run: { config: { brand: true, audiogram: { coverAssetId: COVER_ID } } },
      brandKits: kits,
    });

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(enqueuedPayload(h).audiogram).toEqual({
      background: "#102040",
      accent: "#ffd400",
      artwork: cover,
    });
    expect(kits.coverArtwork).toHaveBeenCalledWith(WS, COVER_ID);
  });

  it("draws the kit's logo when the run uses the kit and has no cover", async () => {
    h = harness({ media: AUDIO, run: { config: { brand: true } }, brandKits: brandKits() });

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(enqueuedPayload(h).audiogram?.artwork).toEqual({
      key: `ws/${WS}/brand/${LOGO_ID}.png`,
      format: "png",
    });
  });

  it("never reads the kit for a run that does not use it: the cover alone, on the defaults", async () => {
    const kits = brandKits();
    h = harness({
      media: AUDIO,
      run: { config: { audiogram: { coverAssetId: COVER_ID } } },
      brandKits: kits,
    });

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(enqueuedPayload(h).audiogram).toEqual({
      background: "#141217",
      accent: "#f1ece6",
      artwork: cover,
    });
    expect(kits.forClips).not.toHaveBeenCalled();
  });

  it("still cuts the clip when the cover cannot be read, without artwork", async () => {
    h = harness({
      media: AUDIO,
      run: { config: { audiogram: { coverAssetId: COVER_ID } } },
      brandKits: brandKits({ throws: true }),
    });

    const clip = await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    expect(clip.state).toBe("cutting");
    expect(enqueuedPayload(h).audiogram).toEqual({ background: "#141217", accent: "#f1ece6" });
  });

  it("draws every other format of an Autopilot clip too, each at its own size", async () => {
    h = harness({
      media: AUDIO,
      run: { config: { automation: "auto" }, status: "review_ready", currentStage: "review" },
    });
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));

    await h.service.reconcileClips(RUN);

    const cuts = enqueuedPayloads(h).filter((payload) => payload.aspect !== undefined);
    expect(cuts.map((payload) => [payload.aspect, payload.profile.maxHeight])).toEqual([
      ["4:5", 1_350],
      ["1:1", 1_080],
      ["16:9", 1_080],
    ]);
    for (const payload of cuts) expect(payload.audiogram).toBeDefined();
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

  it("cuts nothing while the source is still being encoded, and fails nothing", async () => {
    h = harness({ media: { status: "probing" } });
    h.tables.clips.push(clipRow(CAND_A));
    expect(await h.service.reconcileClips(RUN)).toEqual({ enqueued: [] });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.tables.runs[0]?.["status"]).toBe("candidates_ready");
  });

  it("fails the run when its source failed and no clip was ever made", async () => {
    h = harness({ media: { status: "failed", failureReason: "media/corrupt" } });
    h.tables.clips.push(clipRow(CAND_A));
    await h.service.reconcileClips(RUN);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.tables.runs[0]).toMatchObject({
      status: "failed",
      failureCode: "repurpose/processing_failed",
      currentStage: "getting_video",
    });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps a run whose source failed after a clip was made", async () => {
    h = harness({
      run: { status: "materializing", currentStage: "styles_formats" },
      media: { status: "failed", failureReason: "media/corrupt" },
    });
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }), clipRow(CAND_B));
    await h.service.reconcileClips(RUN);
    expect(h.tables.runs[0]?.["status"]).not.toBe("failed");
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

describe("Autopilot", () => {
  const auto = { config: { automation: "auto" } };

  it("cuts every moment the run found, with nobody asking", async () => {
    h = harness({ run: auto });
    const { enqueued } = await h.service.reconcileClips(RUN);
    expect(h.tables.clips.map((clip) => clip["candidateId"]).sort()).toEqual(
      [CAND_A, CAND_B].sort(),
    );
    expect(enqueued).toHaveLength(2);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.tables.runs[0]?.["status"]).toBe("materializing");
  });

  it("never gives a moment a second clip, and leaves a rejected one alone", async () => {
    h = harness({ run: auto });
    h.tables.candidates[1] = { ...h.tables.candidates[1], state: "rejected" };
    await h.service.reconcileClips(RUN);
    await h.service.reconcileClips(RUN);
    expect(h.tables.clips.map((clip) => clip["candidateId"])).toEqual([CAND_A]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a run whose person picks the moments", async () => {
    await h.service.reconcileClips(RUN);
    expect(h.tables.clips).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("cuts a clip again after a passing failure, at most three cuts in all", async () => {
    h = harness({ run: { ...auto, status: "materializing", currentStage: "styles_formats" } });
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { updatedAt: new Date(0) }));
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/tool_timeout" }));

    await h.service.reconcileClips(RUN);
    expect(h.enqueue).toHaveBeenCalledTimes(1);

    // Two cuts ended without a clip, then a third: no fourth.
    for (const job of h.tables.jobs) {
      Object.assign(job, {
        status: "failed",
        finishedAt: new Date(),
        error: { code: "media/tool_timeout" },
      });
    }
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/tool_timeout" }));
    h.enqueue.mockClear();
    await h.service.reconcileClips(RUN);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("never cuts again a clip that can only fail the same way", async () => {
    h = harness({ run: { ...auto, status: "materializing", currentStage: "styles_formats" } });
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { updatedAt: new Date(0) }));
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/too_large" }));
    await h.service.reconcileClips(RUN);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("Autopilot's other formats", () => {
  const auto = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  const formatCuts = (h: Harness) =>
    h.enqueue.mock.calls
      .map((call) => call[0] as { jobKey: string; params: { aspect?: string } })
      .filter((input) => input.jobKey.startsWith("media.clip.format:"));

  it("cuts 4:5, 1:1 and 16:9 once every 9:16 clip of the run is made", async () => {
    h = harness({ run: auto });
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));
    await h.service.reconcileClips(RUN);
    const cuts = formatCuts(h);
    expect(cuts.map((cut) => cut.params.aspect)).toEqual(["4:5", "1:1", "16:9"]);
    expect(cuts[0]?.jobKey.startsWith(`media.clip.format:${CAND_A}:4x5:`)).toBe(true);

    // In flight: not asked for again.
    h.enqueue.mockClear();
    await h.service.reconcileClips(RUN);
    expect(formatCuts(h)).toHaveLength(0);
  });

  it("waits while any 9:16 clip is still being cut, so Reels come first", async () => {
    h = harness({ run: auto });
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }), clipRow(CAND_B));
    h.tables.jobs.push(jobRow(CAND_B, "running"));
    await h.service.reconcileClips(RUN);
    expect(formatCuts(h)).toHaveLength(0);
  });

  it("cuts nothing for a run whose person picks the moments", async () => {
    h = harness({ run: { status: "review_ready", currentStage: "review" } });
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));
    await h.service.reconcileClips(RUN);
    expect(formatCuts(h)).toHaveLength(0);
  });
});

describe("Autopilot's captioned videos", () => {
  const ready = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  const CHILD = "01JCCH1LD0000000000000000A";

  /** One ready clip with a 9:16 variant, prepared media and a captions document. */
  function readyClip(
    h: Harness,
    variant: Row = {},
    doc: Row = { revision: 3, updatedAt: new Date(Date.now() - 10 * 60_000) },
    media: Row = { facesKey: "faces.json" },
  ): void {
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4", title: "A moment" }));
    const clipId = h.tables.clips[0]?.["id"];
    h.tables.variants.push({
      id: "01JCVAR1ANT000000000000000",
      clipId,
      aspect: "r9x16",
      profileVersion: CLIP_PROFILE_VERSION,
      projectId: CHILD,
      editFingerprint: "",
      status: "ready",
      latestExportId: null,
      ...variant,
    });
    h.tables.media.push({
      id: "01JCCH1LDMED1A000000000000",
      projectId: CHILD,
      role: "primary",
      status: "ready",
      failureReason: null,
      durationMs: 30_000,
      createdAt: new Date(clock++),
      ...media,
    });
    h.tables.docs.push({ projectId: CHILD, ...doc });
  }

  it("makes a captioned video of each ready clip, from the clip's own project", async () => {
    h = harness({ run: ready });
    readyClip(h);
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
    expect(h.requestExport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: CHILD, kind: "video", mode: "cloud", preset: "reels" }),
    );
    expect(h.tables.variants[0]).toMatchObject({ status: "rendering", editFingerprint: "edg:3" });

    // Asked once: a render in flight is waited for, not asked for again.
    h.tables.exports.push({
      id: h.tables.variants[0]?.["latestExportId"],
      projectId: CHILD,
      status: "rendering",
      storageKey: null,
    });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
  });

  it("asks again on a later pass when asking failed with something other than a refusal", async () => {
    h = harness({ run: ready });
    readyClip(h);
    h.requestExport.mockRejectedValue(new Error("Timed out fetching a new connection"));
    for (let pass = 1; pass <= 4; pass += 1) {
      await h.service.reconcileClips(RUN);
      expect(h.requestExport).toHaveBeenCalledTimes(pass);
      // Not failed: the next pass asks again.
      expect(h.tables.variants[0]?.["status"]).toBe("ready");
    }
    // The fifth failure in a row is final until the captions change.
    await h.service.reconcileClips(RUN);
    expect(h.tables.variants[0]).toMatchObject({ status: "failed", editFingerprint: "edg:3" });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(5);
  });

  it("forgets the earlier failures once asking works", async () => {
    h = harness({ run: ready });
    readyClip(h);
    h.requestExport
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"));
    await h.service.reconcileClips(RUN);
    await h.service.reconcileClips(RUN);
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(3);
    expect(h.tables.variants[0]).toMatchObject({ status: "rendering", editFingerprint: "edg:3" });
  });

  it("takes a refusal as final at once", async () => {
    h = harness({ run: ready });
    readyClip(h);
    h.requestExport.mockRejectedValueOnce(
      new AppException("exports/no_credits", "Out of credits.", 402),
    );
    await h.service.reconcileClips(RUN);
    expect(h.tables.variants[0]).toMatchObject({ status: "failed", editFingerprint: "edg:3" });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
  });

  describe("a shape whose media broke off mid-pipeline (2026-09-29)", () => {
    const MEDIA_ID = "01JCCH1LDMED1A000000000000";
    const longAgo = new Date(Date.now() - 30 * 60_000);
    function stranded(media: Row, jobs: Row[] = []) {
      const restartStranded = vi.fn(async () => "queued");
      h = harness({ run: ready, probeRestart: { restartStranded } });
      readyClip(h, {}, undefined, {
        facesKey: null,
        storageKey: "ws/x/p/child/master.mp4",
        mime: "video/mp4",
        sizeBytes: 1_000n,
        createdAt: longAgo,
        ...media,
      });
      h.tables.jobs.push(
        ...jobs.map((job) => ({ workspaceId: WS, queuedAt: longAgo, finishedAt: longAgo, ...job })),
      );
      return restartStranded;
    }

    it("sends media whose proxy failed on a passing error back through the probe", async () => {
      const restart = stranded({ status: "failed" }, [
        { jobKey: `media.probe:${MEDIA_ID}`, status: "succeeded", error: null },
        {
          jobKey: `media.proxy:${MEDIA_ID}`,
          status: "failed",
          error: { code: "media/failed", retryable: true },
          queuedAt: new Date(longAgo.getTime() + 1),
        },
      ]);
      await h.service.reconcileClips(RUN);
      expect(restart).toHaveBeenCalledWith(
        expect.objectContaining({
          id: MEDIA_ID,
          status: "failed",
          projectId: "01JCCH1LD0000000000000000A",
        }),
        WS,
      );
      expect(h.requestExport).not.toHaveBeenCalled();
    });

    it("restarts a probe that was never enqueued, once nothing has moved for ten minutes", async () => {
      const restart = stranded({ status: "uploaded" });
      await h.service.reconcileClips(RUN);
      expect(restart).toHaveBeenCalledTimes(1);

      const fresh = stranded({ status: "uploaded", createdAt: new Date() });
      await h.service.reconcileClips(RUN);
      expect(fresh).not.toHaveBeenCalled();
    });

    it("leaves a refusal, a pipeline still moving, and a media probed three times alone", async () => {
      const refused = stranded({ status: "failed" }, [
        {
          jobKey: `media.proxy:${MEDIA_ID}`,
          status: "failed",
          error: { code: "media/unreadable", retryable: false },
        },
      ]);
      await h.service.reconcileClips(RUN);
      expect(refused).not.toHaveBeenCalled();

      const moving = stranded({ status: "probing" }, [
        { jobKey: `media.proxy:${MEDIA_ID}`, status: "running", error: null },
      ]);
      await h.service.reconcileClips(RUN);
      expect(moving).not.toHaveBeenCalled();

      const probe = {
        jobKey: `media.probe:${MEDIA_ID}`,
        status: "failed",
        error: { retryable: true },
      };
      const spent = stranded({ status: "failed" }, [probe, probe, probe]);
      await h.service.reconcileClips(RUN);
      expect(spent).not.toHaveBeenCalled();

      // Too long for the plan: the probe succeeded and said so. A verdict.
      const tooLong = stranded({ status: "failed" }, [
        { jobKey: `media.probe:${MEDIA_ID}`, status: "succeeded", error: null },
      ]);
      await h.service.reconcileClips(RUN);
      expect(tooLong).not.toHaveBeenCalled();
    });
  });

  it("shows the finished file, and makes it again a minute after the captions change", async () => {
    h = harness({ run: ready });
    readyClip(h, { latestExportId: "01JCEXP0000000000000000001", editFingerprint: "edg:3" });
    h.tables.exports.push({
      id: "01JCEXP0000000000000000001",
      projectId: CHILD,
      status: "succeeded",
      storageKey: "exports/clip.mp4",
    });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    const [item] = (await h.service.listClips(WS, RUN)).clips;
    expect(item?.captioned).toMatchObject({ status: "ready" });
    expect(item?.captioned?.playUrl).toContain("exports/clip.mp4");

    // Edited just now: the old file stays on the card, marked as being updated.
    Object.assign(h.tables.docs[0] ?? {}, { revision: 4, updatedAt: new Date() });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    const [edited] = (await h.service.listClips(WS, RUN)).clips;
    expect(edited?.captioned).toMatchObject({ status: "stale" });
    expect(edited?.captioned?.playUrl).toContain("exports/clip.mp4");

    // A minute later with no more edits: made again from revision 4.
    Object.assign(h.tables.docs[0] ?? {}, { updatedAt: new Date(Date.now() - 61_000) });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
    expect(h.tables.variants[0]).toMatchObject({ status: "rendering", editFingerprint: "edg:4" });
  });

  it("tries a failed render again, and gives up after three", async () => {
    h = harness({ run: ready });
    readyClip(h, { latestExportId: "01JCEXP0000000000000000003", editFingerprint: "edg:3" });
    h.tables.exports.push({
      id: "01JCEXP0000000000000000003",
      projectId: CHILD,
      status: "failed",
      storageKey: null,
    });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);

    h = harness({ run: ready });
    readyClip(h, { latestExportId: "01JCEXP0000000000000000003", editFingerprint: "edg:3" });
    for (const n of [1, 2, 3]) {
      h.tables.exports.push({
        id: `01JCEXP000000000000000000${String(n)}`,
        projectId: CHILD,
        status: "failed",
        storageKey: null,
      });
    }
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    expect(h.tables.variants[0]?.["status"]).toBe("failed");
  });

  it("waits for the clip's face track, so captions keep off faces", async () => {
    h = harness({ run: ready });
    readyClip(h, {}, undefined, { facesKey: null });
    h.tables.jobs.push({
      id: "01JCFACES00000000000000000",
      type: "ai.faces",
      jobKey: "ai.faces:01JCCH1LDMED1A000000000000",
      status: "running",
      queuedAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
    });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
  });

  it("makes nothing for a run whose person picks the moments", async () => {
    h = harness({ run: { status: "review_ready", currentStage: "review" } });
    readyClip(h);
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    const [item] = (await h.service.listClips(WS, RUN)).clips;
    expect(item?.captioned).toBeNull();
  });

  // Two-speaker layouts (2026-10-01): a clip cut again in a new layout has a
  // new picture, ready a moment before its own face detection is queued.
  it("waits for a clip cut again to have its new picture's faces, then makes its video", async () => {
    h = harness({ run: ready });
    readyClip(
      h,
      { latestExportId: "01JCEXP0000000000000000001", editFingerprint: "", status: "stale" },
      undefined,
      { facesKey: null, width: 1080, uploadedAt: new Date(Date.now() - 30_000) },
    );
    h.tables.exports.push({
      id: "01JCEXP0000000000000000001",
      projectId: CHILD,
      status: "succeeded",
      storageKey: "exports/old-picture.mp4",
    });
    // The first picture's detection, done an hour ago.
    h.tables.jobs.push({
      id: "01JCFACES00000000000000000",
      type: "ai.faces",
      jobKey: "ai.faces:01JCCH1LDMED1A000000000000",
      status: "succeeded",
      queuedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      finishedAt: new Date(Date.now() - 3_590_000),
    });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();

    // The new picture's own detection lands: the video is made again.
    Object.assign(h.tables.media.at(-1) ?? {}, { facesKey: "faces.json" });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
  });
});

describe("Autopilot's finishing pass (clip-finishing.ts)", () => {
  const ready = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  const CHILD = "01JCCH1LD0000000000000000A";
  const RUNNING = { v: 1, state: "running", startedAt: new Date().toISOString(), steps: {} };

  function readyClip(h: Harness, variant: Row = {}): void {
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4", title: "A moment" }));
    h.tables.variants.push({
      id: "01JCVAR1ANT000000000000000",
      clipId: h.tables.clips[0]?.["id"],
      aspect: "r9x16",
      profileVersion: CLIP_PROFILE_VERSION,
      projectId: CHILD,
      editFingerprint: "",
      status: "ready",
      latestExportId: null,
      finishing: null,
      ...variant,
    });
    h.tables.media.push({
      id: "01JCCH1LDMED1A000000000000",
      projectId: CHILD,
      role: "primary",
      status: "ready",
      failureReason: null,
      durationMs: 30_000,
      facesKey: "faces.json",
      createdAt: new Date(clock++),
    });
    h.tables.docs.push({
      projectId: CHILD,
      revision: 3,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
  }

  /** A finishing pass that moves through `outcomes`, one per ask, marking the row as it goes. */
  function finishingThat(h: () => Harness, outcomes: string[]) {
    return {
      advance: vi.fn(async (_run: unknown, variant: { id: string }) => {
        const outcome = outcomes.shift() ?? "finished";
        const row = h().tables.variants.find((v) => v["id"] === variant.id);
        if (row !== undefined) {
          row["finishing"] = outcome === "waiting" ? RUNNING : { ...RUNNING, state: "done" };
        }
        return outcome;
      }),
    };
  }

  it("makes the captioned video only once the edit is finished, from the finished revision", async () => {
    const finishing = finishingThat(() => h, ["waiting", "just-finished"]);
    h = harness({ run: ready, finishing });
    readyClip(h);

    await h.service.reconcileClips(RUN);
    expect(finishing.advance).toHaveBeenCalledTimes(1);
    expect(h.requestExport).not.toHaveBeenCalled();
    const [finishingItem] = (await h.service.listClips(WS, RUN)).clips;
    expect(finishingItem?.captioned).toEqual({
      status: "finishing",
      playUrl: null,
      downloadUrl: null,
    });
    expect(finishingItem?.formats[0]).toMatchObject({ shape: "9:16", status: "finishing" });

    // Finished on this pass: the video is asked for on the next, once the
    // document's revision includes everything the pass wrote.
    Object.assign(h.tables.docs[0] ?? {}, { revision: 9 });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
    expect(h.tables.variants[0]).toMatchObject({ status: "rendering", editFingerprint: "edg:9" });
  });

  it("never finishes a clip whose captioned video was already asked for", async () => {
    const finishing = finishingThat(() => h, []);
    h = harness({ run: ready, finishing });
    readyClip(h, { latestExportId: "01JCEXP0000000000000000001", editFingerprint: "edg:3" });
    h.tables.exports.push({
      id: "01JCEXP0000000000000000001",
      projectId: CHILD,
      status: "succeeded",
      storageKey: "exports/clip.mp4",
    });
    await h.service.reconcileClips(RUN);
    expect(finishing.advance).not.toHaveBeenCalled();
  });

  it("never touches the clips of a run whose person picks the moments", async () => {
    const finishing = finishingThat(() => h, []);
    h = harness({ run: { status: "review_ready", currentStage: "review" }, finishing });
    readyClip(h);
    await h.service.reconcileClips(RUN);
    expect(finishing.advance).not.toHaveBeenCalled();
    expect(h.requestExport).not.toHaveBeenCalled();
    const [item] = (await h.service.listClips(WS, RUN)).clips;
    expect(item?.captioned).toBeNull();
  });
});

describe("Autopilot's finishing pass, end to end", () => {
  // The real `ClipFinishing` on this harness, over an editing document run by
  // the real ops engine: what lands in the document before the video is asked
  // for is exactly what the video is made from.
  const ready = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  const CHILD = "01JCCH1LD0000000000000000A";
  const VARIANT = "01JCVAR1ANT000000000000000";
  const EDG = "01JCEDG0000000000000000000";
  const CUT_JOB = "01JCJ0BCVTPASS000000000000";
  const ZOOM_JOB = "01JCJ0BZ00MPASS00000000000";
  const CUT_PASS = "01JCPASSCVT000000000000000";
  const ZOOM_PASS = "01JCPASSZ00M00000000000000";
  const SPOKEN = ["Log", "paise", "bachane", "ke", "5", "tarike", "nahi", "jaante"];

  it("cuts, emphasises, zooms and titles the clip, then makes the video from that document", async () => {
    const words = SPOKEN.map((t, index) => ({
      wid: `0:${String(index)}` as WordId,
      t,
      s: index * 1_000,
      e: index * 1_000 + 800,
    }));
    const chunks = [{ chunkIdx: 0, startMs: 0, endMs: 30_000, words }];
    let state: EdgState = fromProjection(
      {
        meta: { edgId: EDG, projectId: CHILD, revision: 3, schemaVersion: 2 },
        media: [{ mediaId: "01JCCH1LDMED1A000000000000", role: "primary", durationMs: 30_000 }],
        transcript: { transcriptId: TR, revision: 1, language: "hi-Latn", scripts: ["roman"] },
        canvas: { aspect: "9:16", width: 1080, height: 1920 },
        styles: { defaultStyleId: "punch-pop" },
        segments: [
          {
            id: "01JCSEG1000000000000000000",
            seq: "V",
            startWordId: "0:0" as WordId,
            endWordId: "0:7" as WordId,
            startMs: 0,
            endMs: 7_800,
          },
        ],
        passes: [],
      },
      { chunks },
    );
    const jobs = new Map<string, { status: string; finishedAt: Date | null }>();
    const edg = {
      applyWorkerOps: vi.fn(async (input: { ops: readonly EdgOp[] }) => {
        const doc = h.tables.docs[0] ?? {};
        const revision = Number(doc["revision"]) + 1;
        const result = applyOps(state, input.ops, { source: "worker", revision });
        state = result.state;
        Object.assign(doc, { revision, updatedAt: new Date() });
        return { revision, applied: result.applied, rebased: [], rejected: result.rejected };
      }),
    };
    /** What the pass completion handler does: `MergePass`, from the worker. */
    const land = async (pass: Pass): Promise<void> => {
      await edg.applyWorkerOps({ ops: [{ opId: newId(), type: "MergePass", pass }] });
    };
    const finishingRef: { current?: ClipFinishing } = {};
    h = harness({
      run: ready,
      finishing: {
        advance: (...args: Parameters<ClipFinishing["advance"]>) =>
          (finishingRef.current as ClipFinishing).advance(...args),
      },
    });
    Object.assign(h.prisma, {
      edgDocument: {
        findUnique: vi.fn(async () => ({ id: EDG, revision: h.tables.docs[0]?.["revision"] })),
      },
      stylePreset: { findMany: vi.fn(async () => []) },
    });
    Object.assign(h.prisma.job, {
      findUnique: vi.fn(async (args: { where: { id: string } }) => jobs.get(args.where.id) ?? null),
    });
    finishingRef.current = new ClipFinishing(
      h.prisma as never,
      edg as never,
      {
        projectionOf: vi.fn(async () => toProjection(state)),
        loadChunks: vi.fn(async () => chunks),
      } as never,
      {
        forWorkspace: vi.fn(async () => ({
          entitlements: { passes: { autocut: true, reframeZoom: true } },
        })),
      } as never,
      {
        startAutocut: vi.fn(async () => {
          jobs.set(CUT_JOB, { status: "queued", finishedAt: null });
          return { jobId: CUT_JOB, passId: CUT_PASS };
        }),
        startZoom: vi.fn(async () => {
          jobs.set(ZOOM_JOB, { status: "queued", finishedAt: null });
          return { jobId: ZOOM_JOB, passId: ZOOM_PASS };
        }),
      } as never,
    );

    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4", title: "A moment" }));
    h.tables.variants.push({
      id: VARIANT,
      clipId: h.tables.clips[0]?.["id"],
      aspect: "r9x16",
      profileVersion: CLIP_PROFILE_VERSION,
      projectId: CHILD,
      editFingerprint: "",
      status: "ready",
      latestExportId: null,
      finishing: null,
    });
    h.tables.media.push({
      id: "01JCCH1LDMED1A000000000000",
      projectId: CHILD,
      role: "primary",
      status: "ready",
      durationMs: 30_000,
      facesKey: "faces.json",
      createdAt: new Date(clock++),
    });
    h.tables.docs.push({
      projectId: CHILD,
      revision: 3,
      updatedAt: new Date(Date.now() - 600_000),
    });

    // Pass 1: the autocut is asked for; no video yet, and the clip says why.
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();
    expect((await h.service.listClips(WS, RUN)).clips[0]?.captioned).toMatchObject({
      status: "finishing",
    });

    // Pass 2: the cuts land and are taken; the keyword goes on; zooms asked for.
    await land({
      passId: CUT_PASS,
      type: "autocut",
      engine: "autocut@standard",
      params: {},
      status: "ready",
      items: [
        {
          itemId: "01JCCVT1000000000000000000",
          passId: CUT_PASS,
          kind: "cut",
          startMs: 850,
          endMs: 990,
          payload: {},
          confidence: 0.9,
          reason: "pause",
          state: "proposed",
        },
      ],
    });
    jobs.set(CUT_JOB, { status: "succeeded", finishedAt: new Date() });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();

    // Pass 3: the zooms land (the one after the title is taken), the hook
    // title goes on, and the edit is finished; the video waits one more pass.
    await land({
      passId: ZOOM_PASS,
      type: "zoom",
      engine: "zoom@standard",
      params: {},
      status: "ready",
      items: [
        {
          itemId: "01JCZ00M1000000000000000A0",
          passId: ZOOM_PASS,
          kind: "zoom",
          startMs: 4_000,
          endMs: 5_000,
          payload: {
            target: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
            scaleFrom: 1,
            scaleTo: 1.15,
            easing: "easeInOut",
            keyframesRef: "ws/k.bin",
          },
          state: "proposed",
        },
      ],
    });
    jobs.set(ZOOM_JOB, { status: "succeeded", finishedAt: new Date() });
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).not.toHaveBeenCalled();

    const finished = toProjection(state);
    expect(finished.passes.flatMap((pass) => pass.items).map((item) => item.state)).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(finished.segments[0]?.emphasis).toEqual([{ wordId: "0:4", presetId: "pop" }]);
    // The title covers the first 2.5 s as cut: the 140 ms pause is gone.
    expect(finished.overlays).toEqual([
      { id: VARIANT, kind: "hook-title", text: "A moment", startMs: 0, endMs: HOOK_TITLE_MS + 140 },
    ]);

    // Pass 4: the captioned video, from the finished revision.
    await h.service.reconcileClips(RUN);
    expect(h.requestExport).toHaveBeenCalledTimes(1);
    const revision = Number(h.tables.docs[0]?.["revision"]);
    expect(h.tables.variants[0]).toMatchObject({
      status: "rendering",
      editFingerprint: `edg:${String(revision)}`,
    });
    expect(h.tables.variants[0]?.["finishing"]).toMatchObject({ state: "done" });
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
    expect(enqueuedPayload(h).reframe).toMatchObject({ centerX: 0.72, basis: "faces" });
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
    expect(enqueuedPayloads(h).map((payload) => payload.reframe)).toMatchObject([
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
    expect(enqueuedPayload(h).reframe).toMatchObject({ centerX: 0.72, basis: "faces" });
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

describe("Autopilot's images, disk guard and old renders", () => {
  const auto = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  const SHAPES = [
    ["r9x16", "9x16"],
    ["r4x5", "4x5"],
    ["r1x1", "1x1"],
    ["r16x9", "16x9"],
  ] as const;
  const stills = (h: Harness) =>
    h.enqueue.mock.calls
      .map((call) => call[0] as { type: string; jobKey: string; params: Row })
      .filter((input) => input.type === "media.stills");

  /** One ready clip whose four shapes each have a finished captioned video. */
  function everyShapeMade(h: Harness): void {
    h.tables.candidates.length = 1;
    h.tables.clips.push(
      clipRow(CAND_A, {
        mezzanineKey: "ws/w/p/s/repurpose/r/clips/c/master.mp4",
        mezzanineDurationMs: 30_000,
        title: "A moment",
        images: {},
      }),
    );
    const clipId = h.tables.clips[0]?.["id"];
    SHAPES.forEach(([aspect, tag], index) => {
      const project = `01JCCH1LD000000000000000${String(index)}A`;
      const exportId = `01JCEXP00000000000000000${String(index)}A`;
      h.tables.variants.push({
        id: `01JCVAR1ANT00000000000000${String(index)}`,
        clipId,
        aspect,
        profileVersion: CLIP_PROFILE_VERSION,
        projectId: project,
        editFingerprint: "edg:3",
        status: "ready",
        latestExportId: exportId,
      });
      h.tables.media.push({
        id: `01JCCH1LDMED00000000000${String(index)}A`,
        projectId: project,
        role: "primary",
        status: "ready",
        storageKey: `ws/w/p/s/repurpose/r/clips/c/master-${tag}.mp4`,
        facesKey: null,
        durationMs: 30_000,
        failureReason: null,
        createdAt: new Date(clock++),
      });
      h.tables.docs.push({ projectId: project, revision: 3, updatedAt: new Date(0) });
      h.tables.exports.push({
        id: exportId,
        projectId: project,
        status: "succeeded",
        storageKey: `exports/${tag}.mp4`,
      });
    });
  }

  it("takes every image from the clip's videos once all four shapes are made", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    await h.service.reconcileClips(RUN);

    const [job] = stills(h);
    expect(job).toBeDefined();
    const images = job?.params["images"] as { name: string; sourceKey: string; width: number }[];
    // Eleven image files, the carousel five slides: fifteen frames.
    expect(images).toHaveLength(15);
    expect(images.find((row) => row.name === "carousel-5")?.sourceKey).toBe("exports/4x5.mp4");
    expect(images.find((row) => row.name === "pin-1")?.sourceKey).toBe("exports/9x16.mp4");
    // A banner is a clean frame: no captions across a channel's header.
    expect(images.find((row) => row.name === "youtube-banner-1")).toMatchObject({
      sourceKey: "ws/w/p/s/repurpose/r/clips/c/master-16x9.mp4",
      width: 2560,
    });

    // Asked once while it runs.
    h.tables.jobs.push({
      id: "01JCST1LLS0000000000000000",
      workspaceId: WS,
      type: "media.stills",
      jobKey: job?.jobKey,
      status: "running",
      queuedAt: new Date(clock++),
    });
    h.enqueue.mockClear();
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);

    // Filed: the card lists them, and nothing more is asked for.
    Object.assign(h.tables.clips[0] ?? {}, {
      images: {
        fingerprint: job?.params["fingerprint"],
        images: [
          { name: "carousel-1", key: "i/carousel-1.jpg", width: 1080, height: 1350 },
          { name: "carousel-2", key: "i/carousel-2.jpg", width: 1080, height: 1350 },
          { name: "thumbnail-1", key: "i/thumbnail-1.jpg", width: 1280, height: 720 },
        ],
      },
    });
    Object.assign(h.tables.jobs[h.tables.jobs.length - 1] ?? {}, { status: "succeeded" });
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);
    const [item] = (await h.service.listClips(WS, RUN)).clips;
    expect(item?.images.status).toBe("ready");
    expect(item?.images.files.map((file) => [file.id, file.items.length])).toEqual([
      ["carousel", 2],
      ["thumbnail", 1],
    ]);
  });

  it("takes one set at a time: a new set waits for an older one still running", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    const clipId = String(h.tables.clips[0]?.["id"]);
    h.tables.jobs.push({
      id: "01JCST1LLS0000000000000001",
      workspaceId: WS,
      type: "media.stills",
      jobKey: `media.stills:${clipId}:0000000000000000`,
      status: "running",
      queuedAt: new Date(clock++),
    });
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);

    Object.assign(h.tables.jobs[h.tables.jobs.length - 1] ?? {}, { status: "succeeded" });
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(1);
  });

  it("waits for a shape that is still being made", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    Object.assign(h.tables.variants[3] ?? {}, { status: "rendering" });
    Object.assign(h.tables.exports[3] ?? {}, { status: "rendering", storageKey: null });
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);
    const [item] = (await h.service.listClips(WS, RUN)).clips;
    expect(item?.images.status).toBe("preparing");
  });

  // Live, 2026-09-29: a format cut files its variant as `ready` before its
  // captioned video is asked for, and the images were taken from 9:16 alone.
  it("does not count a freshly cut shape as made before its captioned video exists", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    Object.assign(h.tables.variants[1] ?? {}, { status: "ready", latestExportId: null });
    // Its captions document is not built yet, so nothing asks for its render.
    h.tables.docs.splice(1, 1);
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);
  });

  it("holds the other shapes and the images while the disk is low, never the 9:16 clip", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    h.service.freeBytes = async () => 2 * 1024 ** 3;
    await h.service.reconcileClips(RUN);
    expect(stills(h)).toHaveLength(0);

    h = harness({ run: auto });
    h.service.freeBytes = async () => 2 * 1024 ** 3;
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));
    await h.service.reconcileClips(RUN);
    const formatCuts = h.enqueue.mock.calls.filter((call) =>
      String((call[0] as { jobKey: string }).jobKey).startsWith("media.clip.format:"),
    );
    expect(formatCuts).toHaveLength(0);
  });

  // Live, 2026-09-30: C: under the floor held three shapes and the images of
  // every clip for hours while the page said "Being made…" on each of them.
  it("tells the page which shapes and images wait for disk space", async () => {
    const heldView = async (free: number) => {
      h = harness({ run: auto });
      everyShapeMade(h);
      // 4:5 never cut; 1:1 cut but its captioned video never asked for.
      h.tables.variants.splice(1, 1);
      Object.assign(h.tables.variants[1] ?? {}, { latestExportId: null });
      h.service.freeBytes = async () => free;
      const [item] = (await h.service.listClips(WS, RUN)).clips;
      return item;
    };

    const low = await heldView(2 * 1024 ** 3);
    const shapes = new Map(low?.formats.map((format) => [format.shape, format]));
    expect(shapes.get("4:5")).toMatchObject({ status: "preparing", waitingFor: "space" });
    expect(shapes.get("1:1")).toMatchObject({ status: "preparing", waitingFor: "space" });
    // Made shapes, and the 9:16 clip, never wait.
    expect(shapes.get("9:16")?.waitingFor).toBeUndefined();
    expect(shapes.get("16:9")?.waitingFor).toBeUndefined();
    expect(low?.images).toMatchObject({ status: "preparing", waitingFor: "space" });

    const roomy = await heldView(100 * 1024 ** 3);
    expect(roomy?.formats.some((format) => format.waitingFor !== undefined)).toBe(false);
    expect(roomy?.images.waitingFor).toBeUndefined();
  });

  it("deletes the older render of a shape once a newer one is made", async () => {
    h = harness({ run: auto });
    everyShapeMade(h);
    // The 9:16 video was made again after an edit; the first file is still stored.
    Object.assign(h.tables.variants[0] ?? {}, {
      status: "rendering",
      latestExportId: "01JCEXP0000000000000000NEW",
    });
    h.tables.exports.push({
      id: "01JCEXP0000000000000000NEW",
      projectId: h.tables.variants[0]?.["projectId"],
      status: "succeeded",
      storageKey: "exports/9x16-v2.mp4",
    });
    await h.service.reconcileClips(RUN);
    expect(h.derivedDelete).toHaveBeenCalledWith("exports/9x16.mp4");
    expect(h.derivedDelete).not.toHaveBeenCalledWith("exports/9x16-v2.mp4");
    expect(h.tables.exports[0]?.["storageKey"]).toBeNull();
    expect(h.tables.variants[0]?.["status"]).toBe("ready");
  });
});

describe("Steering (2026-09-29): Autopilot's reserve, removed clips, re-timed moments", () => {
  const auto = { config: { automation: "auto" } };

  /** `count` suggestions, ranked best first, a minute apart. */
  function suggestions(count: number): Row[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `01JCCAND${String(index).padStart(2, "0")}0000000000000000`,
      runId: RUN,
      source: "ai",
      state: "proposed",
      rank: index + 1,
      potentialScore: 90 - index,
      startMs: 60_000 * (index + 1),
      endMs: 60_000 * (index + 1) + 30_000,
      title: `Moment ${String(index + 1)}`,
    }));
  }

  it("cuts only the best moments it asked for, and keeps the rest in reserve", async () => {
    // A 10-minute source: Autopilot's target is 5, and discovery was asked for 7.
    h = harness({ run: auto });
    h.tables.candidates.splice(0, h.tables.candidates.length, ...suggestions(7));
    await h.service.reconcileClips(RUN);
    expect(h.tables.clips.map((clip) => clip["candidateId"])).toEqual(
      suggestions(5).map((candidate) => candidate["id"]),
    );
  });

  it("gives a removed clip's place to the best moment in reserve", async () => {
    h = harness({ run: auto });
    const all = suggestions(7);
    h.tables.candidates.splice(0, h.tables.candidates.length, ...all);
    await h.service.reconcileClips(RUN);
    const second = h.tables.candidates[1];
    if (second !== undefined) second["state"] = "rejected";

    await h.service.reconcileClips(RUN);
    expect(h.tables.clips.map((clip) => clip["candidateId"])).toContain(all[5]?.["id"]);
    expect(h.tables.clips.map((clip) => clip["candidateId"])).not.toContain(all[6]?.["id"]);
  });

  it("neither lists a removed moment's clip nor cuts, retries or re-shapes it", async () => {
    h = harness({ run: { ...auto, status: "materializing", currentStage: "styles_formats" } });
    h.tables.candidates[0] = { ...h.tables.candidates[0], state: "rejected" };
    h.tables.clips.push(
      // Waiting: would be cut by the reconcile.
      clipRow(CAND_A, { updatedAt: new Date() }),
      clipRow(CAND_B, { mezzanineKey: "ws/master.mp4" }),
    );
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/tool_timeout" }));

    const { clips } = await h.service.listClips(WS, RUN);
    expect(clips.map((clip) => clip.candidateId)).toEqual([CAND_B]);
    const cuts = h.enqueue.mock.calls.map((call) => (call[0] as { jobKey: string }).jobKey);
    expect(cuts.some((key) => key.includes(CAND_A))).toBe(false);
  });

  it("spends no cut on a removed moment, asked for or retried", async () => {
    h.tables.candidates[0] = { ...h.tables.candidates[0], state: "rejected" };
    await expectCode(
      h.service.createClip(WS, USER, RUN, { candidateId: CAND_A }),
      "repurpose/candidate_removed",
      409,
    );
    const clip = clipRow(CAND_A);
    h.tables.clips.push(clip);
    h.tables.jobs.push(jobRow(CAND_A, "failed", { code: "media/corrupt" }));
    await expectCode(
      h.service.retryClip(WS, USER, RUN, String(clip["id"])),
      "repurpose/candidate_removed",
      409,
    );
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("cuts a re-timed moment's shapes afresh: its old times' cuts are not this cut's", async () => {
    h = harness({ run: { ...auto, status: "review_ready", currentStage: "review" } });
    h.tables.candidates.length = 1;
    h.tables.clips.push(clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" }));
    // A 4:5 cut of the moment's old times succeeded; its variant went with them.
    h.tables.jobs.push({
      ...jobRow(CAND_A, "succeeded"),
      jobKey: `media.clip.format:${CAND_A}:4x5:55000-90000:${CLIP_PROFILE_VERSION}`,
    });
    await h.service.reconcileClips(RUN);
    const formats = h.enqueue.mock.calls
      .map((call) => (call[0] as { jobKey: string }).jobKey)
      .filter((key) => key.startsWith("media.clip.format:"));
    expect(formats).toContain(
      `media.clip.format:${CAND_A}:4x5:60000-90000:${CLIP_PROFILE_VERSION}`,
    );
  });
});

describe("Two-speaker layouts (2026-10-01)", () => {
  const auto = { config: { automation: "auto" }, status: "review_ready", currentStage: "review" };
  /** Two people at a table across candidate A (60-90 s), one wide camera. */
  function twoPeople(h: Harness): void {
    const w = (0.14 * 9) / 16 / 0.9;
    h.derivedGet.mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          version: 1,
          intervalMs: 250,
          source: { width: 1920, height: 1080 },
          samples: Array.from({ length: 140 }, (_, i) => [
            59_000 + i * 250,
            [
              [0.3 - w / 2, 0.33, w, 0.14],
              [0.72 - w / 2, 0.35, w, 0.13],
            ],
          ]),
        }),
      ),
    );
  }
  const enqueued = (h: Harness) =>
    h.enqueue.mock.calls.map((call) => {
      const input = call[0] as { jobKey: string; params: unknown };
      return { jobKey: input.jobKey, payload: MediaClipPayloadSchema.parse(input.params) };
    });
  const formatCut = (h: Harness, shape: string) =>
    enqueued(h).find((cut) => cut.jobKey.startsWith(`media.clip.format:${CAND_A}:${shape}:`));
  /** A ready clip of moment A whose shapes are `shapes`, each `{ aspect, layout }`. */
  function readyClip(h: Harness, shapes: readonly Row[]): Row {
    h.tables.candidates.length = 1;
    const clip = clipRow(CAND_A, { mezzanineKey: "ws/master.mp4" });
    h.tables.clips.push(clip);
    for (const [index, shape] of shapes.entries()) {
      h.tables.variants.push({
        id: `01JCVAR${String(index).padStart(19, "0")}`,
        clipId: clip["id"],
        projectId: `01JCPR0J${String(index).padStart(18, "0")}`,
        profileVersion: CLIP_PROFILE_VERSION,
        ...shape,
      });
    }
    return clip;
  }

  it("stacks the 9:16 cut of two people side by side, and names it in the job key", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    twoPeople(h);

    await h.service.createClip(WS, USER, RUN, { candidateId: CAND_A });

    const [cut] = enqueued(h);
    expect(cut?.payload.reframe).toMatchObject({ centerX: 0.3, basis: "faces", layout: "stacked" });
    expect(cut?.payload.reframe?.people?.map((person) => person.centerX)).toEqual([0.3, 0.72]);
    expect(cut?.jobKey).toBe(`media.clip:${CAND_A}:60000-90000:${CLIP_PROFILE_VERSION}:stacked`);
  });

  it("cuts one window, with the key it always had, for a clip set to one speaker", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    twoPeople(h);
    h.tables.clips.push(clipRow(CAND_A, { layout: "single" }));

    await h.service.retryClip(WS, USER, RUN, String(h.tables.clips[0]?.["id"]));

    const [cut] = enqueued(h);
    expect(cut?.payload.reframe).toEqual({ centerX: 0.3, centerY: 0.4, basis: "faces" });
    expect(cut?.jobKey).toBe(`media.clip:${CAND_A}:60000-90000:${CLIP_PROFILE_VERSION}`);
  });

  it("stacks the 4:5 cut like its 9:16 picture, and never the 1:1 or 16:9", async () => {
    h = harness({ run: auto, media: { facesKey: FACES_KEY } });
    twoPeople(h);
    readyClip(h, [{ aspect: "r9x16", layout: "stacked" }]);

    await h.service.reconcileClips(RUN);

    const portrait = formatCut(h, "4x5");
    expect(portrait?.payload.reframe?.layout).toBe("stacked");
    expect(portrait?.jobKey.endsWith(`:${CLIP_PROFILE_VERSION}:stacked`)).toBe(true);
    for (const shape of ["1x1", "16x9"]) {
      const cut = formatCut(h, shape);
      expect(cut?.payload.reframe?.layout, shape).toBeUndefined();
      expect(cut?.jobKey.endsWith(`:${CLIP_PROFILE_VERSION}`), shape).toBe(true);
    }
  });

  it("cuts the 4:5 of a clip made in one window in one window, whoever the track finds", async () => {
    // A clip cut before layouts existed: its 9:16 picture is one window, and
    // its other shapes match it rather than change on their own.
    h = harness({ run: auto, media: { facesKey: FACES_KEY } });
    twoPeople(h);
    readyClip(h, [{ aspect: "r9x16", layout: "single" }]);

    await h.service.reconcileClips(RUN);

    expect(formatCut(h, "4x5")?.payload.reframe?.layout).toBeUndefined();
  });

  it("cuts the 4:5 shape again once its clip's picture is stacked, a few tries at most", async () => {
    h = harness({ run: auto, media: { facesKey: FACES_KEY } });
    twoPeople(h);
    readyClip(h, [
      { aspect: "r9x16", layout: "stacked" },
      { aspect: "r4x5", layout: "single" },
      { aspect: "r1x1", layout: "single" },
      { aspect: "r16x9", layout: "single" },
    ]);
    // The one-window 4:5 cut that made it: done, and not this layout's.
    h.tables.jobs.push({
      ...jobRow(CAND_A, "succeeded"),
      jobKey: `media.clip.format:${CAND_A}:4x5:60000-90000:${CLIP_PROFILE_VERSION}`,
    });

    await h.service.reconcileClips(RUN);

    const cuts = enqueued(h);
    expect(cuts.map((cut) => cut.jobKey)).toEqual([
      `media.clip.format:${CAND_A}:4x5:60000-90000:${CLIP_PROFILE_VERSION}:stacked`,
    ]);
    expect(cuts[0]?.payload.aspect).toBe("4:5");

    // Three failed cuts in the new layout, and it is left as it is.
    h.enqueue.mockClear();
    const stackedKey = `media.clip.format:${CAND_A}:4x5:60000-90000:${CLIP_PROFILE_VERSION}:stacked`;
    for (const job of h.tables.jobs) {
      if (job["jobKey"] === stackedKey)
        Object.assign(job, { status: "failed", finishedAt: new Date() });
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      h.tables.jobs.push({ ...jobRow(CAND_A, "failed"), jobKey: stackedKey });
    }
    await h.service.reconcileClips(RUN);
    expect(enqueued(h)).toHaveLength(0);
  });

  it("does not cut a shape again in a layout the face track cannot make", async () => {
    // The 9:16 picture is stacked, but the track (gone, say) finds nobody now:
    // a 4:5 re-cut would come out as it is, on every pass.
    h = harness({ run: auto });
    readyClip(h, [
      { aspect: "r9x16", layout: "stacked" },
      { aspect: "r4x5", layout: "single" },
      { aspect: "r1x1", layout: "single" },
      { aspect: "r16x9", layout: "single" },
    ]);
    await h.service.reconcileClips(RUN);
    expect(enqueued(h)).toHaveLength(0);
  });

  it("says what a cut of a moment would be under each choice", async () => {
    h = harness({ media: { facesKey: FACES_KEY } });
    twoPeople(h);
    const run = h.tables.runs[0] as never;
    const candidate = h.tables.candidates[0] as never;
    expect(await h.service.layoutFor(run, candidate, "auto")).toBe("stacked");
    expect(await h.service.layoutFor(run, candidate, "stacked")).toBe("stacked");
    expect(await h.service.layoutFor(run, candidate, "single")).toBe("single");

    // One person: one window, even for "both speakers".
    h = harness({ media: { facesKey: FACES_KEY } });
    trackLands(h);
    expect(
      await h.service.layoutFor(
        h.tables.runs[0] as never,
        h.tables.candidates[0] as never,
        "stacked",
      ),
    ).toBe("single");
  });
});
