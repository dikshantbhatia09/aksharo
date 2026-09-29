import { describe, expect, it, vi } from "vitest";

import { REPURPOSE_CLIP_ERRORS } from "./repurpose-clips.dto.js";
import { REPURPOSE_STEERING_ERRORS } from "./repurpose-steering.dto.js";
import { RepurposeSteeringService } from "./repurpose-steering.service.js";
import { AppException } from "../common/index.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const SRC = "01JCSRCPR0JECT000000000000";
const CAND_A = "01JCCANDA00000000000000000";
const CAND_B = "01JCCANDB00000000000000000";
const CLIP_A = "01JCC11PA00000000000000000";
const TR = "01JCTRANSCR1PT000000000000";
const P916 = "01JCPR0J916000000000000000";
const P45 = "01JCPR0J45000000000000000A";

type Row = Record<string, unknown>;

/** Speech from 59 s to 92 s, a word every half second or so, with a pause at 75-80 s. */
function words(): Row[] {
  const list: Row[] = [];
  let at = 59_000;
  let n = 0;
  while (at < 92_000) {
    if (at >= 75_000 && at < 80_000) {
      at = 80_000;
      continue;
    }
    list.push({ wid: `0:${String(n)}`, s: at, e: at + 400, t: `w${String(n)}` });
    n += 1;
    at += 500;
  }
  return list;
}

interface Tables {
  run: Row;
  candidates: Row[];
  clips: Row[];
  variants: Row[];
  jobs: Row[];
  exports: Row[];
  media: Row;
}

function harness(overrides: { run?: Row; media?: Row } = {}) {
  const t: Tables = {
    run: {
      id: RUN,
      workspaceId: WS,
      sourceProjectId: SRC,
      status: "review_ready",
      config: { automation: "manual" },
      ...overrides.run,
    },
    candidates: [
      {
        id: CAND_A,
        runId: RUN,
        source: "ai",
        state: "proposed",
        startMs: 60_000,
        endMs: 70_000,
        startWordId: "0:2",
        endWordId: "0:21",
        title: "A moment",
        transcriptExcerpt: "",
      },
      {
        id: CAND_B,
        runId: RUN,
        source: "manual",
        state: "proposed",
        startMs: 80_000,
        endMs: 89_900,
        startWordId: null,
        endWordId: null,
        title: "Moment at 1:20–1:29",
        transcriptExcerpt: "",
      },
    ],
    clips: [],
    variants: [],
    jobs: [],
    exports: [],
    media: {
      status: "ready",
      durationMs: 600_000,
      rawPurgedAt: null,
      ...overrides.media,
    },
  };

  const candidateById = (id: unknown): Row | undefined => t.candidates.find((c) => c["id"] === id);
  const prisma = {
    repurposeRun: {
      findFirst: vi.fn(async (args: { where: Row }) =>
        args.where["id"] === t.run["id"] && args.where["workspaceId"] === t.run["workspaceId"]
          ? { ...t.run }
          : null,
      ),
    },
    clipCandidate: {
      findFirst: vi.fn(async (args: { where: Row }) => {
        const where = args.where;
        if ("startMs" in where) {
          const notId = (where["id"] as { not?: string } | undefined)?.not;
          return (
            t.candidates.find(
              (c) =>
                c["startMs"] === where["startMs"] &&
                c["endMs"] === where["endMs"] &&
                c["id"] !== notId,
            ) ?? null
          );
        }
        const row = candidateById(where["id"]);
        return row !== undefined && row["runId"] === where["runId"] ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async (args: { where: Row }) => ({
        ...candidateById(args.where["id"]),
      })),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        const row = candidateById(args.where["id"]);
        if (row === undefined) return { count: 0 };
        const state = args.where["state"];
        const matches =
          typeof state === "string"
            ? row["state"] === state
            : row["state"] !== (state as { not: string }).not;
        if (!matches) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { where: Row; data: Row }) =>
        Object.assign(candidateById(args.where["id"]) ?? {}, args.data),
      ),
    },
    repurposeClip: {
      findUnique: vi.fn(async (args: { where: Row }) => {
        const clip = t.clips.find((c) => c["candidateId"] === args.where["candidateId"]);
        return clip === undefined
          ? null
          : {
              ...clip,
              variants: t.variants
                .filter((v) => v["clipId"] === clip["id"])
                .map((v) => ({ projectId: v["projectId"] })),
            };
      }),
      count: vi.fn(
        async (args: { where: Row }) =>
          t.clips.filter((c) => c["candidateId"] === args.where["candidateId"]).length,
      ),
      findMany: vi.fn(async () => t.clips.map((c) => ({ candidateId: c["candidateId"] }))),
      update: vi.fn(async (args: { where: Row; data: Row }) =>
        Object.assign(t.clips.find((c) => c["id"] === args.where["id"]) ?? {}, args.data),
      ),
    },
    clipVariant: {
      deleteMany: vi.fn(async (args: { where: Row }) => {
        const before = t.variants.length;
        t.variants = t.variants.filter((v) => v["clipId"] !== args.where["clipId"]);
        return { count: before - t.variants.length };
      }),
    },
    transcript: { findFirst: vi.fn(async () => ({ id: TR })) },
    mediaAsset: { findFirst: vi.fn(async () => ({ ...t.media })) },
    transcriptChunk: {
      findMany: vi.fn(async () => [
        { id: "c0", transcriptId: TR, chunkIdx: 0, revision: 1, words: words() },
      ]),
    },
    job: {
      findFirst: vi.fn(
        async (args: { where: Row }) =>
          t.jobs.find(
            (job) =>
              job["status"] === args.where["status"] &&
              String(job["jobKey"]).startsWith(
                (args.where["jobKey"] as { startsWith: string }).startsWith,
              ),
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { OR: Row[] } }) =>
        t.jobs.filter(
          (job) =>
            ["queued", "running"].includes(String(job["status"])) &&
            args.where.OR.some((branch) => {
              const key = (branch["jobKey"] as { startsWith?: string } | undefined)?.startsWith;
              if (key !== undefined) return String(job["jobKey"]).startsWith(key);
              const projects = (branch["projectId"] as { in: string[] } | undefined)?.in ?? [];
              const types = (branch["type"] as { in: string[] } | undefined)?.in ?? [];
              return (
                projects.includes(String(job["projectId"])) && types.includes(String(job["type"]))
              );
            }),
        ),
      ),
    },
    export: {
      findMany: vi.fn(async (args: { where: Row }) =>
        t.exports.filter(
          (row) =>
            row["projectId"] === args.where["projectId"] &&
            row["status"] === "succeeded" &&
            row["storageKey"] !== null,
        ),
      ),
      update: vi.fn(async (args: { where: Row; data: Row }) =>
        Object.assign(t.exports.find((row) => row["id"] === args.where["id"]) ?? {}, args.data),
      ),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };

  const cancel = vi.fn(async (jobId: string) => {
    const job = t.jobs.find((row) => row["id"] === jobId);
    if (job !== undefined) job["status"] = "cancelled";
  });
  const clips = {
    createClip: vi.fn(async () => ({ id: CLIP_A, candidateId: CAND_A, state: "cutting" })),
    reconcileClips: vi.fn(async (): Promise<{ enqueued: string[] }> => ({ enqueued: [] })),
  };
  const projects = { softDelete: vi.fn(async (_ws: string, id: string) => ({ id })) };
  const audit = { record: vi.fn(async () => undefined) };
  const derived = { delete: vi.fn(async () => undefined) };
  const env = { FEATURE_FLAGS_JSON: { repurpose_flow: true } };

  const service = new RepurposeSteeringService(
    prisma as never,
    { cancel } as never,
    clips as never,
    projects as never,
    { forWorkspace: vi.fn() } as never,
    audit as never,
    env as never,
    derived as never,
  );
  return { service, t, prisma, cancel, clips, projects, audit, derived, env };
}

/** A clip of moment A with a 9:16 and a 4:5 shape, a finished render, and work in flight. */
function withReadyClip(h: ReturnType<typeof harness>): void {
  h.t.clips.push({
    id: CLIP_A,
    runId: RUN,
    candidateId: CAND_A,
    mezzanineKey: "ws/master.mp4",
  });
  h.t.variants.push(
    { clipId: CLIP_A, aspect: "r9x16", projectId: P916 },
    { clipId: CLIP_A, aspect: "r4x5", projectId: P45 },
  );
  h.t.exports.push({ id: "E1", projectId: P916, status: "succeeded", storageKey: "ws/r1.mp4" });
  h.t.jobs.push(
    { id: "J-render", type: "render.video", projectId: P45, status: "running", jobKey: "r" },
    { id: "J-proxy", type: "media.proxy", projectId: P916, status: "queued", jobKey: "p" },
    {
      id: "J-stills",
      type: "media.stills",
      projectId: SRC,
      status: "queued",
      jobKey: `media.stills:${CLIP_A}:abc`,
    },
    {
      id: "J-format",
      type: "media.clip",
      projectId: SRC,
      status: "queued",
      jobKey: `media.clip.format:${CAND_A}:1x1:60000-70000:3`,
    },
    // Another moment's work is never touched.
    {
      id: "J-other",
      type: "media.clip",
      projectId: SRC,
      status: "queued",
      jobKey: `media.clip:${CAND_B}:80000-90000:3`,
    },
  );
}

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AppException);
  return error as AppException;
}

describe("removeCandidate", () => {
  it("marks the moment removed and stops what is still being made for its clip", async () => {
    const h = harness();
    withReadyClip(h);
    const result = await h.service.removeCandidate(WS, USER, RUN, CAND_A);

    expect(result.candidate["state"]).toBe("rejected");
    // Its renders, images and other shapes stop; its projects' own pipeline is
    // left to finish (the clip comes back as it was on a restore).
    expect(h.cancel.mock.calls.map((call) => call[0]).sort()).toEqual(
      ["J-format", "J-render", "J-stills"].sort(),
    );
    expect(h.projects.softDelete).not.toHaveBeenCalled();
    expect(h.clips.reconcileClips).toHaveBeenCalledWith(RUN);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.candidate.removed", resourceId: CAND_A }),
    );
  });

  it("says which moment Autopilot cut in its place", async () => {
    const h = harness({ run: { config: { automation: "auto" } } });
    withReadyClip(h);
    h.clips.reconcileClips.mockImplementation(async () => {
      h.t.clips.push({ id: "01JCC11PB00000000000000000", candidateId: CAND_B });
      return { enqueued: ["01JCC11PB00000000000000000"] };
    });
    const result = await h.service.removeCandidate(WS, USER, RUN, CAND_A);
    expect(result.promoted).toEqual([CAND_B]);
  });

  it("is a no-op the second time", async () => {
    const h = harness();
    withReadyClip(h);
    await h.service.removeCandidate(WS, USER, RUN, CAND_A);
    h.cancel.mockClear();
    h.clips.reconcileClips.mockClear();
    const again = await h.service.removeCandidate(WS, USER, RUN, CAND_A);
    expect(again.candidate["state"]).toBe("rejected");
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.clips.reconcileClips).not.toHaveBeenCalled();
  });

  it("answers 404 for another run's moment, and while the surface is off", async () => {
    const h = harness();
    const missing = await refusal(
      h.service.removeCandidate(WS, USER, RUN, "01JCCANDZ00000000000000000"),
    );
    expect(missing.httpStatus).toBe(404);
    h.env.FEATURE_FLAGS_JSON.repurpose_flow = false;
    const off = await refusal(h.service.removeCandidate(WS, USER, RUN, CAND_A));
    expect(off.httpStatus).toBe(404);
  });
});

describe("restoreCandidate", () => {
  it("brings the moment back and asks again for the cut removing it stopped", async () => {
    const h = harness();
    withReadyClip(h);
    await h.service.removeCandidate(WS, USER, RUN, CAND_A);
    const result = await h.service.restoreCandidate(WS, USER, RUN, CAND_A);

    expect(result.candidate["state"]).toBe("proposed");
    // Idempotent per moment: a ready clip comes back unchanged, a stopped cut is cut.
    expect(h.clips.createClip).toHaveBeenCalledWith(WS, USER, RUN, { candidateId: CAND_A });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.candidate.restored" }),
    );
  });

  it("cuts nothing on a stopped run, and changes nothing for a moment that was never removed", async () => {
    const h = harness({ run: { status: "cancelled" } });
    withReadyClip(h);
    h.t.candidates[0] = { ...h.t.candidates[0], state: "rejected" };
    await h.service.restoreCandidate(WS, USER, RUN, CAND_A);
    expect(h.clips.createClip).not.toHaveBeenCalled();

    const live = harness();
    const result = await live.service.restoreCandidate(WS, USER, RUN, CAND_A);
    expect(result.candidate["state"]).toBe("proposed");
    expect(live.prisma.clipCandidate.updateMany).not.toHaveBeenCalled();
  });
});

describe("adjustCandidate", () => {
  it("moves a moment with no clip, snapped to the words, and cuts nothing", async () => {
    const h = harness();
    const result = await h.service.adjustCandidate(WS, USER, RUN, CAND_A, {
      startMs: 61_130,
      endMs: 70_000,
    });
    // 61.13 s is inside the word at 61.0-61.4 s: the start goes to a word start.
    expect(result.candidate).toMatchObject({ startMs: 61_000, endMs: 70_000 });
    expect(result.candidate["startWordId"]).toBe("0:4");
    expect(String(result.candidate["transcriptExcerpt"]).startsWith("w4 w5")).toBe(true);
    expect(h.clips.createClip).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("starts a clip over at its new times: fresh shapes, old work stopped, cut again", async () => {
    const h = harness();
    withReadyClip(h);
    const result = await h.service.adjustCandidate(WS, USER, RUN, CAND_A, {
      startMs: 59_000,
      endMs: 70_000,
    });

    expect(result.candidate).toMatchObject({ startMs: 59_000, endMs: 70_000 });
    // No picture until the new cut lands, no images, no shapes.
    expect(h.t.clips[0]).toMatchObject({
      sourceStartMs: 59_000,
      sourceEndMs: 70_000,
      mezzanineKey: null,
      mezzanineJobId: null,
      images: {},
    });
    expect(h.t.variants).toEqual([]);
    // Everything still being made for it stops - its projects' pipeline too -
    // and nothing of another moment's.
    expect(h.cancel.mock.calls.map((call) => call[0]).sort()).toEqual(
      ["J-format", "J-proxy", "J-render", "J-stills"].sort(),
    );
    // The old shapes' projects are set aside and their finished videos deleted.
    expect(h.projects.softDelete.mock.calls.map((call) => call[1]).sort()).toEqual(
      [P45, P916].sort(),
    );
    expect(h.derived.delete).toHaveBeenCalledWith("ws/r1.mp4");
    expect(h.t.exports[0]?.["storageKey"]).toBeNull();
    // Cut again through the ordinary cut, whose job key carries the new times.
    expect(h.clips.createClip).toHaveBeenCalledWith(WS, USER, RUN, { candidateId: CAND_A });
    expect(result.clip).toMatchObject({ state: "cutting" });
  });

  it("retitles a moment added by time, and keeps a suggestion's own title", async () => {
    const h = harness();
    const manual = await h.service.adjustCandidate(WS, USER, RUN, CAND_B, {
      startMs: 81_000,
      endMs: 89_900,
    });
    expect(manual.candidate["title"]).toBe("Moment at 1:21–1:29");
    const suggested = await h.service.adjustCandidate(WS, USER, RUN, CAND_A, {
      startMs: 62_000,
      endMs: 70_000,
    });
    expect(suggested.candidate["title"]).toBe("A moment");
  });

  it("refuses times no clip can have, and changes nothing", async () => {
    const h = harness();
    for (const times of [
      { startMs: 60_000, endMs: 61_000 },
      { startMs: 60_000, endMs: 260_000 },
    ]) {
      const error = await refusal(h.service.adjustCandidate(WS, USER, RUN, CAND_A, times));
      expect(error.code).toBe(REPURPOSE_CLIP_ERRORS.boundsInvalid);
      expect(error.httpStatus).toBe(400);
    }
    expect(h.prisma.clipCandidate.update).not.toHaveBeenCalled();
  });

  it("refuses the times another moment already has, once snapped", async () => {
    const h = harness();
    // 90.0 s snaps to the word ending at 89.9 s: moment B's own times.
    const error = await refusal(
      h.service.adjustCandidate(WS, USER, RUN, CAND_A, { startMs: 80_000, endMs: 90_000 }),
    );
    expect(error.code).toBe(REPURPOSE_STEERING_ERRORS.boundsTaken);
    expect(error.httpStatus).toBe(409);
  });

  it("waits for a cut that is running, rather than race it", async () => {
    const h = harness();
    withReadyClip(h);
    h.t.jobs.push({
      id: "J-cut",
      type: "media.clip",
      status: "running",
      jobKey: `media.clip:${CAND_A}:60000-70000:3`,
    });
    const error = await refusal(
      h.service.adjustCandidate(WS, USER, RUN, CAND_A, { startMs: 59_000, endMs: 70_000 }),
    );
    expect(error.code).toBe(REPURPOSE_STEERING_ERRORS.clipBusy);
    expect(h.prisma.clipCandidate.update).not.toHaveBeenCalled();
  });

  it("refuses a removed moment, a stopped run and a source whose original is gone", async () => {
    const removed = harness();
    removed.t.candidates[0] = { ...removed.t.candidates[0], state: "rejected" };
    expect(
      (
        await refusal(
          removed.service.adjustCandidate(WS, USER, RUN, CAND_A, { startMs: 1, endMs: 2 }),
        )
      ).code,
    ).toBe(REPURPOSE_STEERING_ERRORS.candidateRemoved);

    const stopped = harness({ run: { status: "cancelled" } });
    expect(
      (
        await refusal(
          stopped.service.adjustCandidate(WS, USER, RUN, CAND_A, { startMs: 1, endMs: 2 }),
        )
      ).code,
    ).toBe(REPURPOSE_CLIP_ERRORS.runNotReady);

    const purged = harness({ media: { rawPurgedAt: new Date(0) } });
    expect(
      (
        await refusal(
          purged.service.adjustCandidate(WS, USER, RUN, CAND_A, { startMs: 59_000, endMs: 70_000 }),
        )
      ).code,
    ).toBe(REPURPOSE_CLIP_ERRORS.sourceExpired);
  });

  it("changes nothing when the times snap back onto the ones it has", async () => {
    const h = harness();
    withReadyClip(h);
    const result = await h.service.adjustCandidate(WS, USER, RUN, CAND_A, {
      startMs: 60_000,
      endMs: 70_000,
    });
    expect(result.candidate).toMatchObject({ startMs: 60_000, endMs: 70_000 });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.clips.createClip).not.toHaveBeenCalled();
  });
});
