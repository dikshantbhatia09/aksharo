import { describe, expect, it, vi } from "vitest";

import {
  CLIP_RUNNING_CEILING_MS,
  clipFactsOf,
  clipStateOf,
  latestClipJobs,
  settleRunAfterClips,
} from "./clip-state.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { Prisma } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const RUN = "01JCRN0000000000000000000A";
const CAND_A = "01JCCANDA00000000000000000";
const CAND_B = "01JCCANDB00000000000000000";

interface JobRow {
  id: string;
  jobKey: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: Prisma.JsonValue;
}

function job(
  id: string,
  candidateId: string,
  status: JobRow["status"],
  error: Prisma.JsonValue = null,
): JobRow {
  return { id, jobKey: `media.clip:${candidateId}:0-30000:2`, status, error };
}

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const minutesAgo = (minutes: number): Date => new Date(NOW - minutes * 60_000);

/** A job with the timings the state reads, `minutes` after it was queued. */
function timedJob(
  status: JobRow["status"],
  timings: { queuedAt?: Date; startedAt?: Date | null; finishedAt?: Date | null } = {},
) {
  return {
    ...job("J1", CAND_A, status),
    queuedAt: timings.queuedAt ?? minutesAgo(10),
    startedAt: timings.startedAt ?? null,
    finishedAt: timings.finishedAt ?? null,
    maxQueueWaitMs: 30 * 60_000,
  };
}

/** Jobs are given newest first, the order the query asks the database for. */
function prismaWith(options: {
  run?: Record<string, unknown> | null;
  clips?: Record<string, unknown>[];
  jobs?: JobRow[];
  updated?: number;
  /** The source's original has been deleted by retention. */
  rawPurged?: boolean;
}) {
  const updateMany = vi.fn(async () => ({ count: options.updated ?? 1 }));
  const jobFindMany = vi.fn(async () => options.jobs ?? []);
  const mediaFindFirst = vi.fn(async () => ({
    rawPurgedAt: options.rawPurged === true ? new Date(0) : null,
  }));
  const prisma = {
    mediaAsset: { findFirst: mediaFindFirst },
    repurposeRun: {
      findUnique: vi.fn(async () =>
        options.run === undefined
          ? { id: RUN, workspaceId: WS, status: "materializing" }
          : options.run,
      ),
      updateMany,
    },
    repurposeClip: { findMany: vi.fn(async () => options.clips ?? []) },
    job: { findMany: jobFindMany },
  } as unknown as PrismaService;
  return { prisma, updateMany, jobFindMany, mediaFindFirst };
}

describe("clipStateOf", () => {
  it("is ready once the mezzanine exists, whatever its jobs say", () => {
    expect(clipStateOf({ mezzanineKey: "k" }, job("J1", CAND_A, "failed"))).toEqual({
      state: "ready",
      failureCode: null,
    });
  });

  it("is waiting when no job was ever admitted for it", () => {
    // The three production orphans of 2026-09-19 look exactly like this.
    expect(clipStateOf({ mezzanineKey: null }, undefined).state).toBe("waiting");
  });

  it("is cutting while its newest job is queued or running", () => {
    expect(clipStateOf({ mezzanineKey: null }, job("J1", CAND_A, "queued")).state).toBe("cutting");
    expect(clipStateOf({ mezzanineKey: null }, job("J1", CAND_A, "running")).state).toBe("cutting");
  });

  it("is failed, with the job's own code, when its newest job failed", () => {
    expect(
      clipStateOf(
        { mezzanineKey: null },
        job("J1", CAND_A, "failed", { code: "media/unsupported", message: "x", retryable: false }),
      ),
    ).toEqual({ state: "failed", failureCode: "media/unsupported" });
  });

  it("is failed, not waiting forever, once the source's original is gone", () => {
    expect(clipStateOf({ mezzanineKey: null }, undefined, { sourceGone: true })).toEqual({
      state: "failed",
      failureCode: "repurpose/source_expired",
    });
    // A clip whose cut already ran keeps its own story.
    expect(
      clipStateOf({ mezzanineKey: null }, job("J1", CAND_A, "queued"), { sourceGone: true }).state,
    ).toBe("cutting");
  });

  it("is failed when a cut succeeded but was never recorded, so it can be retried", () => {
    expect(clipStateOf({ mezzanineKey: null }, job("J1", CAND_A, "succeeded"))).toEqual({
      state: "failed",
      failureCode: null,
    });
  });

  it("is failed, with the media's reason, when the cut landed but the child media failed", () => {
    // Before, this read `ready` for good: the editor could not open it, the
    // preview answered 409 forever, and neither a retry nor a new request
    // would cut it again (CLAUDE.md §13's repair path).
    const clip = {
      mezzanineKey: "k",
      childMedia: { status: "failed", failureReason: "media/probe_failed" },
    };
    expect(clipStateOf(clip, timedJob("succeeded"), { now: NOW })).toEqual({
      state: "failed",
      failureCode: "media/probe_failed",
    });
    // ...and cutting while that repair is on its way.
    expect(clipStateOf(clip, timedJob("queued"), { now: NOW }).state).toBe("cutting");
  });

  it("stays ready while the child media is still being prepared", () => {
    expect(
      clipStateOf(
        { mezzanineKey: "k", childMedia: { status: "processing", failureReason: null } },
        timedJob("succeeded"),
        { now: NOW },
      ).state,
    ).toBe("ready");
  });

  it("is failed when its job is over and the child media was never made", () => {
    const clip = { mezzanineKey: "k", childMedia: null };
    expect(clipStateOf(clip, timedJob("failed"), { now: NOW }).state).toBe("failed");
    // The handler may still be making it while the job is open, and with no job
    // at all there is nothing to judge by.
    expect(
      clipStateOf(clip, timedJob("running", { startedAt: minutesAgo(1) }), { now: NOW }).state,
    ).toBe("ready");
    expect(clipStateOf(clip, undefined, { now: NOW }).state).toBe("ready");
  });

  it("is waiting when a cut was asked for after its newest job ended", () => {
    // A retry the full lane refused: the newest job is still the failed one,
    // and without the touch the clip would read failed and never be cut.
    const failed = timedJob("failed", { finishedAt: minutesAgo(5) });
    expect(
      clipStateOf({ mezzanineKey: null, updatedAt: minutesAgo(1) }, failed, { now: NOW }),
    ).toEqual({ state: "waiting", failureCode: null });
    expect(
      clipStateOf(
        {
          mezzanineKey: "k",
          updatedAt: minutesAgo(1),
          childMedia: { status: "failed", failureReason: "media/probe_failed" },
        },
        failed,
        { now: NOW },
      ).state,
    ).toBe("waiting");
  });

  it("does not take the completion handler's own write for a request", () => {
    // The handler writes the clip while its job is still open, so before the
    // job's `finishedAt`.
    expect(
      clipStateOf(
        { mezzanineKey: null, updatedAt: minutesAgo(5) },
        timedJob("failed", { finishedAt: minutesAgo(4) }),
        { now: NOW },
      ).state,
    ).toBe("failed");
  });

  it("is failed, not cutting forever, when its job stalled", () => {
    // Production runs no queue-timeout task (MONTAJ_SCHEDULER_DISABLED=1).
    expect(
      clipStateOf({ mezzanineKey: null }, timedJob("queued", { queuedAt: minutesAgo(31) }), {
        now: NOW,
      }),
    ).toEqual({ state: "failed", failureCode: "jobs/queue_timeout" });
    expect(
      clipStateOf(
        { mezzanineKey: null },
        timedJob("running", { startedAt: new Date(NOW - CLIP_RUNNING_CEILING_MS - 1) }),
        { now: NOW },
      ),
    ).toEqual({ state: "failed", failureCode: "repurpose/clip_stalled" });
    expect(
      clipStateOf({ mezzanineKey: null }, timedJob("running", { startedAt: minutesAgo(20) }), {
        now: NOW,
      }).state,
    ).toBe("cutting");
  });
});

describe("clipFactsOf", () => {
  it("reads the 9:16 variant's newest primary media and profile", () => {
    const facts = clipFactsOf({
      mezzanineKey: "k",
      updatedAt: minutesAgo(1),
      variants: [
        { aspect: "r1x1", profileVersion: "9", project: { mediaAssets: [] } },
        {
          aspect: "r9x16",
          profileVersion: "2",
          project: {
            mediaAssets: [
              { role: "primary", status: "ready", failureReason: null, createdAt: minutesAgo(9) },
              {
                role: "primary",
                status: "failed",
                failureReason: "media/corrupt",
                createdAt: minutesAgo(3),
              },
              { role: "overlay", status: "ready", failureReason: null, createdAt: minutesAgo(1) },
            ],
          },
        },
      ],
    });
    expect(facts).toEqual({
      mezzanineKey: "k",
      updatedAt: minutesAgo(1),
      profileVersion: "2",
      childMedia: { status: "failed", failureReason: "media/corrupt" },
    });
  });

  it("tells a clip with no child media from one whose variants were not loaded", () => {
    expect(clipFactsOf({ mezzanineKey: "k", variants: [] }).childMedia).toBeNull();
    expect(clipFactsOf({ mezzanineKey: "k" })).not.toHaveProperty("childMedia");
  });
});

describe("latestClipJobs", () => {
  it("keeps the newest job per moment", async () => {
    const { prisma } = prismaWith({
      jobs: [job("J3", CAND_A, "queued"), job("J2", CAND_B, "failed"), job("J1", CAND_A, "failed")],
    });
    const latest = await latestClipJobs(prisma, WS, [CAND_A, CAND_B]);
    expect(latest.get(CAND_A)?.id).toBe("J3");
    expect(latest.get(CAND_B)?.id).toBe("J2");
  });

  it("asks nothing of the database for no clips", async () => {
    const { prisma, jobFindMany } = prismaWith({});
    expect((await latestClipJobs(prisma, WS, [])).size).toBe(0);
    expect(jobFindMany).not.toHaveBeenCalled();
  });
});

describe("settleRunAfterClips", () => {
  it("leaves a run alone while another clip is still being cut", async () => {
    const { prisma, updateMany } = prismaWith({
      clips: [
        { candidateId: CAND_A, mezzanineKey: null },
        { candidateId: CAND_B, mezzanineKey: null },
      ],
      jobs: [job("JA", CAND_A, "running"), job("JB", CAND_B, "running")],
    });
    expect(await settleRunAfterClips(prisma, RUN, { finishingJobId: "JA" })).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("counts the failing job as over, though its row still says running", async () => {
    // Handlers run before the status flip. Without this the last clip to fail
    // would always see itself in flight and the run would never move on.
    const { prisma, updateMany } = prismaWith({
      clips: [
        { candidateId: CAND_A, mezzanineKey: "ws/master.mp4" },
        { candidateId: CAND_B, mezzanineKey: null },
      ],
      jobs: [job("JB", CAND_B, "running")],
    });
    const settled = await settleRunAfterClips(prisma, RUN, { finishingJobId: "JB" });
    expect(settled?.status).toBe("review_ready");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: RUN, status: "materializing" },
      data: { status: "review_ready", currentStage: "review", progress: 85 },
    });
  });

  it("returns a run whose every clip failed to its moments, never to failed", async () => {
    const { prisma, updateMany } = prismaWith({
      clips: [{ candidateId: CAND_A, mezzanineKey: null }],
      jobs: [job("JA", CAND_A, "running")],
    });
    const settled = await settleRunAfterClips(prisma, RUN, { finishingJobId: "JA" });
    expect(settled?.status).toBe("candidates_ready");
    const data = (updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).not.toHaveProperty("failureCode");
  });

  it("keeps a run materializing while a clip waits for a slot", async () => {
    const { prisma, updateMany } = prismaWith({
      clips: [
        { candidateId: CAND_A, mezzanineKey: null },
        { candidateId: CAND_B, mezzanineKey: null },
      ],
      jobs: [job("JA", CAND_A, "running")],
    });
    expect(await settleRunAfterClips(prisma, RUN, { finishingJobId: "JA" })).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not wait on a clip that can never be cut, because its source was purged", async () => {
    const { prisma, updateMany } = prismaWith({
      clips: [
        { candidateId: CAND_A, mezzanineKey: "ws/master.mp4" },
        { candidateId: CAND_B, mezzanineKey: null },
      ],
      rawPurged: true,
    });
    expect((await settleRunAfterClips(prisma, RUN))?.status).toBe("review_ready");
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("only looks at the source when a clip is waiting", async () => {
    const { prisma, mediaFindFirst } = prismaWith({
      clips: [{ candidateId: CAND_A, mezzanineKey: "ws/master.mp4" }],
    });
    await settleRunAfterClips(prisma, RUN);
    expect(mediaFindFirst).not.toHaveBeenCalled();
  });

  it("only ever moves a materializing run, or a candidates_ready one on to review", async () => {
    for (const status of ["review_ready", "failed", "cancelled", "analyzing"]) {
      const { prisma, updateMany } = prismaWith({
        run: { id: RUN, workspaceId: WS, status },
        clips: [{ candidateId: CAND_A, mezzanineKey: "k" }],
      });
      expect(await settleRunAfterClips(prisma, RUN)).toBeUndefined();
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("takes a candidates_ready run that already has a ready clip on to review", async () => {
    // A moment cut while the run was still analysing: the highlights
    // completion then moves it to candidates_ready, clip and all.
    const { prisma, updateMany } = prismaWith({
      run: { id: RUN, workspaceId: WS, status: "candidates_ready" },
      clips: [{ candidateId: CAND_A, mezzanineKey: "k" }],
    });
    expect((await settleRunAfterClips(prisma, RUN))?.status).toBe("review_ready");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: RUN, status: "candidates_ready" },
      data: { status: "review_ready", currentStage: "review", progress: 85 },
    });
  });

  it("leaves a candidates_ready run with no ready clip where it is", async () => {
    const { prisma, updateMany } = prismaWith({
      run: { id: RUN, workspaceId: WS, status: "candidates_ready" },
      clips: [{ candidateId: CAND_A, mezzanineKey: null }],
      jobs: [job("JA", CAND_A, "failed")],
    });
    expect(await settleRunAfterClips(prisma, RUN)).toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not count a clip whose child media failed as ready", async () => {
    const { prisma } = prismaWith({
      clips: [
        {
          candidateId: CAND_A,
          mezzanineKey: "k",
          variants: [
            {
              aspect: "r9x16",
              profileVersion: "2",
              project: {
                mediaAssets: [
                  {
                    role: "primary",
                    status: "failed",
                    failureReason: "media/probe_failed",
                    createdAt: new Date(0),
                  },
                ],
              },
            },
          ],
        },
      ],
      jobs: [job("JA", CAND_A, "succeeded")],
    });
    expect((await settleRunAfterClips(prisma, RUN))?.status).toBe("candidates_ready");
  });

  it("does not wait on a job that stalled", async () => {
    const { prisma } = prismaWith({
      clips: [
        { candidateId: CAND_A, mezzanineKey: "k" },
        { candidateId: CAND_B, mezzanineKey: null },
      ],
      jobs: [
        {
          ...job("JB", CAND_B, "running"),
          queuedAt: new Date(0),
          startedAt: new Date(0),
          finishedAt: null,
          maxQueueWaitMs: 30 * 60_000,
        } as JobRow,
      ],
    });
    expect((await settleRunAfterClips(prisma, RUN))?.status).toBe("review_ready");
  });

  it("reports nothing when a concurrent change moved the run first", async () => {
    const { prisma } = prismaWith({
      clips: [{ candidateId: CAND_A, mezzanineKey: "k" }],
      updated: 0,
    });
    expect(await settleRunAfterClips(prisma, RUN)).toBeUndefined();
  });
});
