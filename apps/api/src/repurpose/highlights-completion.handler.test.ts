import { beforeEach, describe, expect, it, vi } from "vitest";

import { REPURPOSE_SCHEMA_VERSION } from "@montaj/repurpose-contracts";

import { RepurposeHighlightsCompletionHandler } from "./highlights-completion.handler.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { RepurposeService } from "./repurpose.service.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { RealtimePublisher } from "../realtime/realtime.publisher.js";
import type { Job } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const RUN = "01JCRN0000000000000000000A";
const TRANSCRIPT = "01JCTRANSCR1PT000000000000";

function proposal(startMs: number): Record<string, unknown> {
  return {
    windowId: `w-${String(startMs)}`,
    startMs,
    endMs: startMs + 30_000,
    startWordId: "w1",
    endWordId: "w9",
    title: "A strong moment",
    transcriptExcerpt: "what was said",
    potentialScore: 80,
    scoreBreakdown: {
      hook: 80,
      clarity: 80,
      emotion: 80,
      visualActivity: 80,
      novelty: 80,
      standaloneValue: 80,
      safety: 100,
    },
    reasons: [{ label: "hook", explanation: "It opens with a question." }],
  };
}

function result(proposals: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: REPURPOSE_SCHEMA_VERSION,
    runId: RUN,
    transcriptId: TRANSCRIPT,
    transcriptRevision: 1,
    proposals,
    featureVersion: "features-v1",
    promptVersion: "highlights-v1",
    model: "heuristic",
    windowsConsidered: 40,
  };
}

function job(): Job {
  return {
    id: "01JCJ0B0000000000000000000",
    workspaceId: WS,
    projectId: PROJECT,
    type: "ai.highlights",
    jobKey: `ai.highlights:${RUN}:${TRANSCRIPT}:1:default`,
    params: { runId: RUN, projectId: PROJECT, transcriptId: TRANSCRIPT },
  } as unknown as Job;
}

function succeeded(body: Record<string, unknown>): JobCompletionContext {
  return {
    job: job(),
    attemptId: "01JCATTEMPT000000000000000",
    result: body,
    usage: undefined,
    completion: { status: "succeeded", result: body },
  };
}

function failedWith(code: string): JobCompletionContext {
  return {
    job: job(),
    attemptId: "01JCATTEMPT000000000000000",
    result: undefined,
    usage: undefined,
    completion: { status: "failed", error: { code, message: "no", retryable: false } },
  } as unknown as JobCompletionContext;
}

function harness(status: string) {
  let run = { id: RUN, workspaceId: WS, sourceProjectId: PROJECT, status };
  const createMany = vi.fn(async () => ({ count: 0 }));
  const updateMany = vi.fn(
    async (args: { where: { status: { in: readonly string[] } }; data: { status: string } }) => {
      if (!args.where.status.in.includes(run.status)) return { count: 0 };
      run = { ...run, ...args.data };
      return { count: 1 };
    },
  );
  const tx = { repurposeRun: { updateMany }, clipCandidate: { createMany } };
  const prisma = {
    repurposeRun: { findUnique: vi.fn(async () => ({ ...run })) },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaService;

  const runs = {
    publishStage: vi.fn(async () => undefined),
    failRun: vi.fn(async () => null),
    reconcileRun: vi.fn(async () => undefined),
  };
  const handler = new RepurposeHighlightsCompletionHandler(
    prisma,
    runs as unknown as RepurposeService,
    new JobCompletionRegistry(),
    {} as RealtimePublisher,
  );
  return { handler, runs, createMany, updateMany, current: () => run };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness("analyzing");
});

describe("RepurposeHighlightsCompletionHandler — a result", () => {
  it("stores the moments and moves the run on, together", async () => {
    const outcome = await h.handler.handle(succeeded(result([proposal(0), proposal(60_000)])));

    expect(h.current().status).toBe("candidates_ready");
    expect(h.createMany).toHaveBeenCalledTimes(1);
    expect(outcome.data).toMatchObject({ applied: true, candidatesCreated: 2 });
    expect(h.runs.publishStage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "candidates_ready" }),
      { candidateCount: 2 },
    );
    expect(h.runs.reconcileRun).toHaveBeenCalledWith(RUN);
  });

  it("treats no moments as an answer: the run is ready, with none to pick", async () => {
    // The page offers adding a moment by its times; failing the run would hide that.
    const outcome = await h.handler.handle(succeeded(result([])));

    expect(h.current().status).toBe("candidates_ready");
    expect(h.createMany).not.toHaveBeenCalled();
    expect(outcome.data).toMatchObject({ applied: true, candidatesCreated: 0 });
    expect(h.runs.publishStage).toHaveBeenCalledWith(expect.anything(), { candidateCount: 0 });
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });

  it("never drags a run that moved on back, and stores nothing for it", async () => {
    // A discovery that lands after the person already started cutting clips.
    h = harness("materializing");
    const outcome = await h.handler.handle(succeeded(result([proposal(0)])));

    expect(h.current().status).toBe("materializing");
    expect(h.createMany).not.toHaveBeenCalled();
    expect(outcome.data).toMatchObject({ applied: false, reason: "run_moved_on" });
    expect(h.runs.publishStage).not.toHaveBeenCalled();
  });

  it.each([
    ["run", { runId: "01JCRN0000000000000000000Z" }],
    ["transcript", { transcriptId: "01JCTRANSCR1PT00000000000Z" }],
  ])("refuses moments for a %s the job was not queued for", async (_, swapped) => {
    // A worker that mixed up two concurrent discoveries would put one run's
    // moments into another; the job's params (the API wrote them) decide.
    await expect(
      h.handler.handle(succeeded({ ...result([proposal(0)]), ...swapped })),
    ).rejects.toThrow(/was queued for/);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.current().status).toBe("analyzing");
  });

  it("turns away a result for a run the person stopped", async () => {
    h = harness("cancelled");
    const outcome = await h.handler.handle(succeeded(result([proposal(0)])));
    expect(outcome.data).toMatchObject({ applied: false });
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.current().status).toBe("cancelled");
  });
});

describe("RepurposeHighlightsCompletionHandler — a failure", () => {
  it("fails the run with highlights_failed, the code the page has a sentence for", async () => {
    await h.handler.handleFailure(failedWith("jobs/queue_timeout"));

    // Not the legacy `repurpose/analysis_failed`, which rendered "Something went wrong".
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      "repurpose/highlights_failed",
      "finding_clips",
    );
  });

  it("says a transcript with no word timings is the problem, not the video", async () => {
    // The worker's code for a transcript whose words are all 0/0 (a Sarvam
    // transcript from before the 2026-09-17 fix). Answered with no moments, the
    // page used to say none was worth suggesting.
    await h.handler.handleFailure(failedWith("worker/transcript_untimed"));
    expect(h.runs.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      "repurpose/transcript_untimed",
      "finding_clips",
    );
  });

  it("does nothing for a job that names no run", async () => {
    const ctx = { ...failedWith("x"), job: { ...job(), params: {} } as Job };
    await h.handler.handleFailure(ctx);
    expect(h.runs.failRun).not.toHaveBeenCalled();
  });
});
