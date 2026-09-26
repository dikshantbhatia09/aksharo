import { HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { LIST_RECONCILE_CONCURRENCY, REPURPOSE_FLAGS } from "./repurpose.constants.js";
import { RepurposeService } from "./repurpose.service.js";
import { AppException } from "../common/errors/error-codes.js";

import type { ReconcileReadOptions, RunReconciler } from "./repurpose.service.js";
import type { RepurposeRun } from "@prisma/client";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const PROJECT = "01JCPR0JECT000000000000000";
const MEDIA = "01JCMED1A00000000000000000";
const RUN = "01JCRN0000000000000000000A";
const OTHER_RUN = "01JCRN0000000000000000000B";
const TRANSCRIPT = "01JCTRANSCR1PT000000000000";

function runRow(overrides: Partial<RepurposeRun> = {}): RepurposeRun {
  return {
    id: RUN,
    workspaceId: WS,
    sourceProjectId: PROJECT,
    sourceKind: "youtube_url",
    sourceDisplay: "youtube.com/watch?v=dQw4w9WgXcQ",
    sourceFingerprint: "youtube:dQw4w9WgXcQ",
    mode: "ai",
    status: "draft",
    currentStage: "getting_video",
    progress: 0,
    failureCode: null,
    requestedCandidates: 5,
    config: { sourceLanguage: "en", discovery: { mode: "ai", requestedCandidates: 5 } },
    completedAt: null,
    createdAt: new Date("2026-09-26T10:00:00Z"),
    updatedAt: new Date("2026-09-26T10:00:00Z"),
    ...overrides,
  } as RepurposeRun;
}

interface Options {
  run?: RepurposeRun;
  media?: Record<string, unknown> | null;
  transcript?: { id: string } | null;
  /** What the duplicate check finds, call by call; the last answer repeats. */
  liveRunForLink?: { id: string } | null | Array<{ id: string } | null>;
  /** Leave the reconciler unregistered, like a harness that never boots the module. */
  noReconciler?: boolean;
}

/** A RepurposeService over fakes, with the run held in memory like the table. */
function harness(options: Options = {}) {
  let run = options.run ?? runRow();
  const order: string[] = [];
  const liveAnswers = Array.isArray(options.liveRunForLink)
    ? [...options.liveRunForLink]
    : [options.liveRunForLink ?? null];
  const liveRunForLink = (): { id: string } | null =>
    (liveAnswers.length > 1 ? liveAnswers.shift() : liveAnswers[0]) ?? null;

  const matches = (status: string, where: unknown): boolean => {
    if (where === undefined) return true;
    if (typeof where === "string") return where === status;
    return ((where as { in: string[] }).in ?? []).includes(status);
  };

  const prisma = {
    repurposeRun: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        // `require` reads by id; the duplicate check reads by fingerprint.
        if ("sourceFingerprint" in args.where) return liveRunForLink();
        // Another workspace's run is not found.
        if (args.where["workspaceId"] !== run.workspaceId) return null;
        return { ...run };
      }),
      findUnique: vi.fn(async () => ({ ...run })),
      update: vi.fn(async (args: { data: Partial<RepurposeRun> }) => {
        run = { ...run, ...args.data } as RepurposeRun;
        return { ...run };
      }),
      create: vi.fn(async (args: { data: Partial<RepurposeRun> }) => ({ ...run, ...args.data })),
      delete: vi.fn(async () => ({ ...run })),
      findMany: vi.fn(
        async (): Promise<
          Array<RepurposeRun & { _count: { candidates: number; clips: number } }>
        > => [],
      ),
      updateMany: vi.fn(
        async (args: { where: { status?: unknown }; data: Partial<RepurposeRun> }) => {
          if (!matches(run.status, args.where.status)) return { count: 0 };
          order.push(`run:${String(args.data.status)}`);
          run = { ...run, ...args.data } as RepurposeRun;
          return { count: 1 };
        },
      ),
    },
    mediaAsset: {
      findFirst: vi.fn(async () =>
        options.media === undefined
          ? { id: MEDIA, status: "pending", failureReason: null, uploadedAt: null, storageKey: "k" }
          : options.media,
      ),
    },
    transcript: {
      findFirst: vi.fn(async () => options.transcript ?? null),
      findUnique: vi.fn(async () => ({ id: TRANSCRIPT, currentRevision: 2 })),
    },
    clipCandidate: { count: vi.fn(async () => 0) },
    repurposeClip: { count: vi.fn(async () => 0) },
    clipVariant: { count: vi.fn(async () => 0) },
    job: { findMany: vi.fn(async (): Promise<Array<{ id: string; type: string }>> => []) },
  };

  const jobs = {
    enqueue: vi.fn(async () => {
      order.push("enqueue");
      return { job: { id: "01JCJ0B0000000000000000000" }, deduplicated: false };
    }),
    cancel: vi.fn(async (jobId: string) => {
      order.push(`cancel:${jobId}`);
      return {};
    }),
  };
  const projects = {
    create: vi.fn(async () => ({ id: PROJECT, workspaceId: WS, status: "draft" })),
    softDelete: vi.fn(async () => undefined),
  };
  const styles = { list: vi.fn(async () => [{ id: "punch-pop" }]) };
  const audit = { record: vi.fn(async () => undefined) };
  const realtime = { publish: vi.fn(async () => undefined) };
  const entitlements = {
    forWorkspace: vi.fn(async () => ({ planKey: "free", entitlements: {} })),
  };
  const env = {
    FEATURE_FLAGS_JSON: { [REPURPOSE_FLAGS.flow]: true, [REPURPOSE_FLAGS.youtubeAcquire]: true },
  };

  const service = new RepurposeService(
    prisma as never,
    projects as never,
    {} as never,
    styles as never,
    entitlements as never,
    audit as never,
    realtime as never,
    jobs as never,
    env as never,
    {} as never,
  );

  const reconciler = {
    reconcile: vi.fn(async (value: RepurposeRun) => value),
    reconcileIfDue: vi.fn(async (value: RepurposeRun, _options?: ReconcileReadOptions) => value),
    redrive: vi.fn(async (value: RepurposeRun) => {
      run = { ...value, status: "analyzing", failureCode: null } as RepurposeRun;
      return { ...run };
    }),
    retryPossible: vi.fn(async (_value: RepurposeRun, _failureCode: string | null) => true),
  } satisfies RunReconciler;
  if (options.noReconciler !== true) service.useReconciler(reconciler);

  return {
    service,
    prisma,
    jobs,
    projects,
    audit,
    realtime,
    reconciler,
    order,
    current: () => run,
    /** Another writer moving the run, between this service's read and its write. */
    setRun: (next: RepurposeRun) => {
      run = next;
    },
  };
}

describe("startHighlightDiscovery", () => {
  it("reads 'analyzing' BEFORE the job exists, so a fast result is not dragged back", async () => {
    // Production discovery finishes 0.6 s after it starts; the old order wrote
    // `analyzing` after the enqueue and could overwrite `candidates_ready`.
    const h = harness({ run: runRow({ status: "transcribing" }) });
    const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);

    expect(started).toEqual({ outcome: "queued", jobId: "01JCJ0B0000000000000000000" });
    expect(h.order).toEqual(["run:analyzing", "enqueue"]);
  });

  it("queues discovery outside the plan's lane: it is free and the run was admitted", async () => {
    const h = harness();
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    expect(h.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai.highlights",
        skipAdmission: true,
        jobKey: `ai.highlights:${RUN}:${TRANSCRIPT}:2:default`,
      }),
    );
  });

  it("starts nothing for a run that has moved on or stopped", async () => {
    for (const status of ["candidates_ready", "cancelled", "failed"] as const) {
      const h = harness({ run: runRow({ status }) });
      const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
      expect(started, status).toEqual({ outcome: "moved_on" });
      expect(h.jobs.enqueue, status).not.toHaveBeenCalled();
      expect(h.current().status, status).toBe(status);
    }
  });

  it("leaves a refused start for the reconciler rather than dropping it", async () => {
    const h = harness();
    h.jobs.enqueue.mockRejectedValueOnce(
      new AppException("common/unavailable", "down", HttpStatus.SERVICE_UNAVAILABLE),
    );
    const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);

    expect(started).toEqual({ outcome: "deferred" });
    // Still waiting, with no job: exactly what the reconciler restarts.
    expect(h.current().status).toBe("analyzing");
  });

  it("leaves a start the database refused for a moment for the reconciler, not failed", async () => {
    // A full pool or a restart blink clears by itself; failing the run made the
    // person press Retry for it.
    for (const code of ["P1001", "P1017", "P2024", "P2034"]) {
      const h = harness();
      h.jobs.enqueue.mockRejectedValueOnce(Object.assign(new Error("database busy"), { code }));
      const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);

      expect(started, code).toEqual({ outcome: "deferred" });
      expect(h.current().status, code).toBe("analyzing");
      expect(h.current().failureCode, code).toBeNull();
    }
  });

  it("fails the run with highlights_failed when discovery cannot be started at all", async () => {
    const h = harness();
    h.jobs.enqueue.mockRejectedValueOnce(new Error("payload rejected"));
    const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);

    expect(started).toEqual({ outcome: "failed" });
    expect(h.current()).toMatchObject({
      status: "failed",
      failureCode: "repurpose/highlights_failed",
      currentStage: "finding_clips",
    });
  });

  it("asks for no suggestions on a manual run: it goes straight to picking moments", async () => {
    // The form sends zero, and `0 || 5` used to turn it into five suggestions.
    const h = harness({ run: runRow({ mode: "manual", requestedCandidates: 0 }) });
    const started = await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);

    expect(started).toEqual({ outcome: "manual" });
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(h.current().status).toBe("candidates_ready");
    expect(h.realtime.publish).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose.stage.changed",
      expect.objectContaining({
        message: "Your video is ready. Add the moments you want to clip.",
      }),
    );
  });
});

describe("failRun", () => {
  it("fails a run still waiting for its moments, audits it and tells the open tab", async () => {
    const h = harness({ run: runRow({ status: "transcribing" }) });
    const failed = await h.service.failRun(h.current(), "repurpose/no_credits", "finding_clips");

    expect(failed).toMatchObject({ status: "failed", failureCode: "repurpose/no_credits" });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "repurpose.run.failed" }),
    );
    expect(h.realtime.publish).toHaveBeenCalledTimes(1);
  });

  it("never fails a run that stopped or moved on to its clips", async () => {
    for (const status of ["cancelled", "failed", "materializing", "review_ready"] as const) {
      const h = harness({ run: runRow({ status }) });
      expect(
        await h.service.failRun(h.current(), "repurpose/transcription_failed", "finding_clips"),
        status,
      ).toBeNull();
      expect(h.current().status, status).toBe(status);
    }
  });
});

describe("retry", () => {
  it("runs the failed stage again instead of resetting the run to draft", async () => {
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/highlights_failed" }),
      transcript: { id: TRANSCRIPT },
    });
    const view = await h.service.retry(WS, USER, RUN);

    expect(h.reconciler.redrive).toHaveBeenCalledWith(expect.objectContaining({ id: RUN }));
    expect(view.status).toBe("analyzing");
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.run.retried",
        data: expect.objectContaining({ toStatus: "analyzing" }),
      }),
    );
  });

  it("answers 404 for another workspace's run before anything else", async () => {
    // Even in a harness that never registered the reconciler: the e2e suites
    // build the service by hand, and a cross-tenant retry must still be a 404.
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      noReconciler: true,
    });
    const refused = (await h.service
      .retry("01JCWS0000000000000000000B", USER, RUN)
      .catch((error: unknown) => error)) as AppException;
    expect(refused).toBeInstanceOf(AppException);
    expect(refused.code).toBe("repurpose/not_found");
    expect(refused.httpStatus).toBe(HttpStatus.NOT_FOUND);
  });

  it("answers 409 for a run that has not failed", async () => {
    const h = harness({ run: runRow({ status: "analyzing" }) });
    const refused = await h.service.retry(WS, USER, RUN).catch((error: unknown) => error);
    expect((refused as AppException).httpStatus).toBe(HttpStatus.CONFLICT);
    expect(h.reconciler.redrive).not.toHaveBeenCalled();
  });

  it("accepts a failure durable state already shows but the row does not yet", async () => {
    const h = harness({ run: runRow({ status: "draft" }) });
    h.reconciler.reconcile.mockImplementationOnce(async (value: RepurposeRun) => ({
      ...value,
      status: "failed",
      failureCode: "repurpose/source_blocked",
    }));
    await h.service.retry(WS, USER, RUN);
    expect(h.reconciler.redrive).toHaveBeenCalled();
  });

  it("refuses a retry of a link that is live in another run, and says which run", async () => {
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
      liveRunForLink: { id: OTHER_RUN },
    });
    const refused = (await h.service
      .retry(WS, USER, RUN)
      .catch((error: unknown) => error)) as AppException;
    expect(refused.code).toBe("repurpose/source_already_running");
    expect(refused.details).toEqual({ existingRunId: OTHER_RUN });
    expect(h.reconciler.redrive).not.toHaveBeenCalled();
  });
});

describe("create — a link that is already running", () => {
  const LINK_RUN = {
    source: {
      kind: "url",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsAttested: true,
    },
    setup: {
      sourceLanguage: "en",
      caption: { styleId: "punch-pop" },
      discovery: { mode: "ai", requestedCandidates: 5 },
    },
  } as never;

  it("answers 409 with the running run's id, so the page can open it", async () => {
    // A finished run (`review_ready`) still holds its link in
    // `repurpose_runs_live_source_idx`; without the id the person was locked out.
    const h = harness({ liveRunForLink: { id: OTHER_RUN } });
    const refused = (await h.service
      .create(WS, USER, LINK_RUN)
      .catch((error: unknown) => error)) as AppException;

    expect(refused.code).toBe("repurpose/source_already_running");
    expect(refused.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(refused.details).toEqual({ existingRunId: OTHER_RUN });
    // Refused before anything was written.
    expect(h.projects.create).not.toHaveBeenCalled();
  });

  it("answers the same 409 when two creates race and the index refuses the second", async () => {
    // Both passed the check; `repurpose_runs_live_source_idx` refused this one.
    const h = harness({ liveRunForLink: [null, { id: OTHER_RUN }] });
    h.prisma.repurposeRun.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const refused = (await h.service
      .create(WS, USER, LINK_RUN)
      .catch((error: unknown) => error)) as AppException;

    expect(refused).toBeInstanceOf(AppException);
    expect(refused.code).toBe("repurpose/source_already_running");
    expect(refused.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(refused.details).toEqual({ existingRunId: OTHER_RUN });
    // The project this create made is taken back: from the person's side it never started.
    expect(h.projects.softDelete).toHaveBeenCalledWith(WS, PROJECT);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("get — a source that failed after the download", () => {
  it("says the run failed, with the reason, never 'Add a video to get started'", async () => {
    const h = harness({
      media: {
        id: MEDIA,
        status: "failed",
        failureReason: "media/too_long",
        uploadedAt: new Date(),
      },
    });
    const view = await h.service.get(WS, RUN);

    expect(h.reconciler.reconcileIfDue).toHaveBeenCalled();
    expect(view.status).toBe("failed");
    expect(view.failureCode).toBe("repurpose/source_too_long");
    expect(view.message).not.toMatch(/Add a video/);
  });

  it("names a download that failed by the downloader's reason", async () => {
    const h = harness({
      media: {
        id: MEDIA,
        status: "failed",
        failureReason: "media/source_private",
        uploadedAt: null,
      },
    });
    const view = await h.service.get(WS, RUN);
    expect(view.failureCode).toBe("repurpose/source_private");
  });
});

describe("canRetry — only a retry the endpoint would run", () => {
  it("is false on a failed run whose retry would be refused", async () => {
    // An upload whose file could not be read: "Try again" was the card's main
    // button, and every press answered 409 repurpose/not_retryable.
    const h = harness({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/processing_failed",
        sourceKind: "upload",
      }),
      media: {
        id: MEDIA,
        status: "failed",
        failureReason: "media/corrupt",
        uploadedAt: new Date(),
      },
    });
    h.reconciler.retryPossible.mockResolvedValueOnce(false);

    const view = await h.service.get(WS, RUN);
    expect(view.status).toBe("failed");
    expect(view.canRetry).toBe(false);
    expect(h.reconciler.retryPossible).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      "repurpose/processing_failed",
    );
  });

  it("is true on a failed run a retry would restart", async () => {
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
    });
    const view = await h.service.get(WS, RUN);
    expect(view.canRetry).toBe(true);
  });

  it("asks about the failure the view shows, before the reconciler has written it", async () => {
    const h = harness({
      media: {
        id: MEDIA,
        status: "failed",
        failureReason: "media/too_long",
        uploadedAt: new Date(),
      },
    });
    h.reconciler.retryPossible.mockResolvedValueOnce(false);
    const view = await h.service.get(WS, RUN);
    expect(h.reconciler.retryPossible).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/source_too_long",
    );
    expect(view.canRetry).toBe(false);
  });

  it("does not ask for a run that has not failed", async () => {
    const h = harness({ run: runRow({ status: "analyzing" }), transcript: { id: TRANSCRIPT } });
    const view = await h.service.get(WS, RUN);
    expect(h.reconciler.retryPossible).not.toHaveBeenCalled();
    expect(view.canRetry).toBe(false);
  });

  it("falls back on the status when the plan cannot be read right now", async () => {
    // A database blink must not take the button off a run a retry would restart.
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/source_blocked" }),
    });
    h.reconciler.retryPossible.mockRejectedValueOnce(new Error("pool"));
    const view = await h.service.get(WS, RUN);
    expect(view.canRetry).toBe(true);
  });

  it("is false on a retry that failed the run straight back, when another would be refused too", async () => {
    const h = harness({
      run: runRow({ status: "failed", failureCode: "repurpose/transcription_failed" }),
    });
    h.reconciler.redrive.mockImplementationOnce(async (value: RepurposeRun) => {
      const failed = { ...value, status: "failed", failureCode: "repurpose/no_credits" };
      h.setRun(failed as RepurposeRun);
      return failed as RepurposeRun;
    });
    h.reconciler.retryPossible.mockResolvedValueOnce(false);

    const view = await h.service.retry(WS, USER, RUN);
    expect(view.status).toBe("failed");
    expect(view.canRetry).toBe(false);
    expect(h.reconciler.retryPossible).toHaveBeenCalledWith(
      expect.anything(),
      "repurpose/no_credits",
    );
  });
});

describe("cancelJobs", () => {
  it("cancels each job, and carries on past one that finished meanwhile", async () => {
    const h = harness();
    h.jobs.cancel.mockRejectedValueOnce(
      new AppException("jobs/invalid_state", "finished", HttpStatus.CONFLICT),
    );
    await h.service.cancelJobs(runRow({ status: "failed" }), ["01JCJ0BA", "01JCJ0BB"]);
    expect(h.jobs.cancel).toHaveBeenCalledWith("01JCJ0BA", WS);
    expect(h.jobs.cancel).toHaveBeenCalledWith("01JCJ0BB", WS);
  });
});

describe("cancel", () => {
  const JOB_A = "01JCJ0B000000000000000000A";
  const JOB_B = "01JCJ0B000000000000000000B";

  function stopQuery(h: ReturnType<typeof harness>): Record<string, unknown> {
    return (
      h.prisma.job.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
  }

  it("stops the run's download, transcription and discovery after the run reads cancelled", async () => {
    const h = harness({ run: runRow({ status: "transcribing" }) });
    h.prisma.job.findMany.mockResolvedValueOnce([
      { id: JOB_A, type: "media.acquire" },
      { id: JOB_B, type: "ai.transcribe" },
    ]);
    // A job that finished in the meantime answers 409; the rest still stop.
    h.jobs.cancel.mockImplementationOnce(async (jobId: string) => {
      h.order.push(`cancel:${jobId}`);
      throw new AppException("jobs/invalid_state", "finished", HttpStatus.CONFLICT);
    });

    const view = await h.service.cancel(WS, USER, RUN);
    expect(view.status).toBe("cancelled");
    expect(h.jobs.cancel).toHaveBeenCalledTimes(2);
    expect(h.jobs.cancel).toHaveBeenCalledWith(JOB_B, WS);
    // The run reads cancelled BEFORE any job is, so each cancelled job's
    // failure handler finds a stopped run and leaves it as it is (rather than
    // failing it with the job's `jobs/cancelled`).
    expect(h.order).toEqual(["run:cancelled", `cancel:${JOB_A}`, `cancel:${JOB_B}`]);

    const where = stopQuery(h);
    expect(where["status"]).toEqual({ in: ["queued", "running"] });
    // Clip cuts are the person's and are left to finish.
    expect(JSON.stringify(where)).not.toContain("media.clip");
  });

  it("also stops the source's probe and proxy: a proxy that finishes starts a paid transcription", async () => {
    const h = harness({ run: runRow({ status: "draft" }) });
    await h.service.cancel(WS, USER, RUN);

    expect(stopQuery(h)["OR"]).toContainEqual({
      type: { in: ["media.probe", "media.proxy"] },
      projectId: PROJECT,
    });
  });

  it("never overwrites a failure that landed between its read and its write", async () => {
    // A blind write turned a run that had just failed into a cancelled one,
    // and lost its failure code.
    // (`observe` reads the source's media between the two: that is the window.)
    const h = harness({ run: runRow({ status: "transcribing" }) });
    h.prisma.mediaAsset.findFirst.mockImplementationOnce(async () => {
      h.setRun(runRow({ status: "failed", failureCode: "repurpose/transcription_failed" }));
      return null;
    });

    const refused = (await h.service
      .cancel(WS, USER, RUN)
      .catch((error: unknown) => error)) as AppException;
    expect(refused.code).toBe("repurpose/not_cancellable");
    expect(h.current()).toMatchObject({
      status: "failed",
      failureCode: "repurpose/transcription_failed",
    });
    expect(h.jobs.cancel).not.toHaveBeenCalled();
  });

  it("stops a run that moved on meanwhile where it now is", async () => {
    const h = harness({ run: runRow({ status: "draft" }) });
    h.prisma.mediaAsset.findFirst.mockImplementationOnce(async () => {
      h.setRun(runRow({ status: "analyzing", currentStage: "finding_clips" }));
      return null;
    });

    const view = await h.service.cancel(WS, USER, RUN);
    expect(view.status).toBe("cancelled");
    expect(h.current()).toMatchObject({ status: "cancelled", currentStage: "finding_clips" });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ data: { fromStatus: "analyzing" } }),
    );
  });

  it("answers as-is when someone else stopped it meanwhile", async () => {
    const h = harness({ run: runRow({ status: "draft" }) });
    h.prisma.mediaAsset.findFirst.mockImplementationOnce(async () => {
      h.setRun(runRow({ status: "cancelled" }));
      return null;
    });

    const view = await h.service.cancel(WS, USER, RUN);
    expect(view.status).toBe("cancelled");
    expect(h.audit.record).not.toHaveBeenCalled();
    expect(h.jobs.cancel).not.toHaveBeenCalled();
  });
});

describe("stopIfCancelled — work handed on while Stop was pressed", () => {
  it("stops the jobs of a run that now reads cancelled", async () => {
    const h = harness({ run: runRow({ status: "cancelled" }) });
    h.prisma.job.findMany.mockResolvedValueOnce([
      { id: "01JCPR0BE000000000000000AA", type: "media.probe" },
    ]);

    expect(await h.service.stopIfCancelled(RUN)).toBe(true);
    expect(h.jobs.cancel).toHaveBeenCalledWith("01JCPR0BE000000000000000AA", WS);
  });

  it("leaves a live run's jobs alone", async () => {
    const h = harness({ run: runRow({ status: "draft" }) });
    expect(await h.service.stopIfCancelled(RUN)).toBe(false);
    expect(h.prisma.job.findMany).not.toHaveBeenCalled();
  });
});

describe("list — reconciling the page", () => {
  it("reconciles a few runs at a time, as a list read, not the whole page at once", async () => {
    const h = harness();
    const page = Array.from({ length: 8 }, (_, index) => ({
      ...runRow({
        id: `01JCRN000000000000000000${String(index).padStart(2, "0")}`,
        status: "review_ready",
      }),
      _count: { candidates: 1, clips: 1 },
    }));
    h.prisma.repurposeRun.findMany.mockResolvedValueOnce(page);

    let inFlight = 0;
    let most = 0;
    h.reconciler.reconcileIfDue.mockImplementation(async (value: RepurposeRun) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return value;
    });

    const listed = await h.service.list(WS, { limit: 20 } as never);
    expect(listed.items.map((item) => item.id)).toEqual(page.map((run) => run.id));
    expect(h.reconciler.reconcileIfDue).toHaveBeenCalledTimes(8);
    expect(h.reconciler.reconcileIfDue).toHaveBeenCalledWith(expect.anything(), { forList: true });
    expect(most).toBeLessThanOrEqual(LIST_RECONCILE_CONCURRENCY);
    expect(most).toBeGreaterThan(1);
  });
});

describe("sweepStuckRuns — the scheduled watchdog", () => {
  const LONG_AGO = new Date("2026-09-26T08:00:00Z");
  const NOW = new Date("2026-09-26T10:00:00Z");

  /** Runs that last moved two hours ago, well past every stage's deadline. */
  function sweepHarness(runs: RepurposeRun[], options: { movedOnMeanwhile?: boolean } = {}) {
    const prisma = {
      repurposeRun: {
        findMany: vi.fn(async (args: { where: { status: { in: string[] } } }) =>
          runs.filter((run) => args.where.status.in.includes(run.status)),
        ),
        updateMany: vi.fn(async () => ({ count: options.movedOnMeanwhile === true ? 0 : 1 })),
        update: vi.fn(async () => ({})),
      },
      mediaAsset: {
        findFirst: vi.fn(async () => ({
          status: "ready",
          failureReason: null,
          uploadedAt: LONG_AGO,
        })),
        findMany: vi.fn(async () => [{ createdAt: LONG_AGO, uploadedAt: LONG_AGO }]),
      },
      transcript: {
        findFirst: vi.fn(async () => ({ id: TRANSCRIPT })),
        findMany: vi.fn(async () => [{ id: TRANSCRIPT, createdAt: LONG_AGO }]),
      },
      transcriptChunk: { findFirst: vi.fn(async () => null) },
      job: { findMany: vi.fn(async () => []) },
      clipCandidate: { findFirst: vi.fn(async () => null) },
      repurposeClip: { findFirst: vi.fn(async () => null) },
      creditHold: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    };
    const audit = { record: vi.fn(async () => undefined) };
    const realtime = { publish: vi.fn(async () => undefined) };
    const service = new RepurposeService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      realtime as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, audit, realtime };
  }

  it("never times out a run that is cutting its clips: a clip's failure is the clip's", async () => {
    const cutting = runRow({ id: OTHER_RUN, status: "materializing", createdAt: LONG_AGO });
    const finding = runRow({
      status: "analyzing",
      currentStage: "finding_clips",
      createdAt: LONG_AGO,
    });
    const h = sweepHarness([cutting, finding]);

    const report = await h.service.sweepStuckRuns(NOW);

    // The watchdog still does its job for a run stuck before its moments...
    expect(report.failedRuns).toEqual([RUN]);
    // ...and never reads the one waiting on its clips (one may be queued behind a full lane).
    expect(report.examined).toBe(1);
    expect(h.prisma.repurposeRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: OTHER_RUN }) }),
    );
  });

  it("does not overwrite a run that moved on while it was being measured", async () => {
    const h = sweepHarness(
      [runRow({ status: "analyzing", currentStage: "finding_clips", createdAt: LONG_AGO })],
      { movedOnMeanwhile: true },
    );

    const report = await h.service.sweepStuckRuns(NOW);

    expect(h.prisma.repurposeRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: RUN, status: "analyzing" } }),
    );
    expect(h.prisma.repurposeRun.update).not.toHaveBeenCalled();
    expect(report.failedRuns).toEqual([]);
    expect(h.realtime.publish).not.toHaveBeenCalled();
    expect(h.audit.record).not.toHaveBeenCalled();
  });
});
