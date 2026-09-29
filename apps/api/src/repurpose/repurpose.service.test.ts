import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  LIST_RECONCILE_CONCURRENCY,
  REPURPOSE_FLAGS,
  acquireTimeoutMs,
} from "./repurpose.constants.js";
import {
  RepurposeService,
  acquireWindowMaxMs,
  affordableWindowMs,
  discoveryLanguage,
  pendingQuoteTenths,
  runWindowMs,
} from "./repurpose.service.js";
import { AppException } from "../common/errors/error-codes.js";
import { quoteTranscription } from "../transcripts/transcripts.quote.js";

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
    rightsAttestedAt: null,
    rightsAttestedBy: null,
    windowStartMs: null,
    windowEndMs: null,
    windowPolicy: null,
    sourceDurationMs: null,
    failureDetail: null,
    sourceTitle: null,
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
  /** `credit_accounts.balance_tenths`; null for a workspace with no account. */
  balanceTenths?: number | null;
  /** The live subscription's plan (admission's view); none is Free. */
  subscriptionPlan?: string | null;
  /** The entitlement document's values. */
  entitlements?: Record<string, unknown>;
  /** What `transcript.findUnique` answers for discovery. */
  transcriptLanguage?: string;
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
      findUnique: vi.fn(async () => ({
        id: TRANSCRIPT,
        currentRevision: 2,
        ...(options.transcriptLanguage === undefined
          ? {}
          : { language: options.transcriptLanguage }),
      })),
    },
    creditAccount: {
      findUnique: vi.fn(async () =>
        options.balanceTenths === null ? null : { balanceTenths: options.balanceTenths ?? 100_000 },
      ),
    },
    subscription: {
      findFirst: vi.fn(async () =>
        options.subscriptionPlan === undefined || options.subscriptionPlan === null
          ? null
          : { plan: { key: options.subscriptionPlan } },
      ),
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
    forWorkspace: vi.fn(async () => ({
      workspaceId: WS,
      planKey: options.subscriptionPlan ?? "free",
      entitlements: options.entitlements ?? {},
    })),
  };
  const media = {
    reserveAcquisition: vi.fn(async () => ({
      media: { id: MEDIA },
      bucket: "s3",
      key: `ws/${WS}/p/${PROJECT}/media/${MEDIA}/raw.mp4`,
    })),
  };
  const env = {
    FEATURE_FLAGS_JSON: { [REPURPOSE_FLAGS.flow]: true, [REPURPOSE_FLAGS.youtubeAcquire]: true },
  };

  const service = new RepurposeService(
    prisma as never,
    projects as never,
    media as never,
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
    media,
    entitlements,
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

// ---------------------------------------------------------------------------
// Clips on long videos (2026-09-27): windows, credits, the next window, the
// numbers behind a failure, and the language discovery reasons in.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A link run, as the form sends it. */
function linkRun(setup: Record<string, unknown> = {}): never {
  return {
    source: {
      kind: "url",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      rightsAttested: true,
    },
    setup: {
      sourceLanguage: "auto",
      caption: { styleId: "punch-pop" },
      discovery: { mode: "ai", requestedCandidates: 5 },
      ...setup,
    },
  } as never;
}

interface EnqueuedAcquire {
  readonly type: string;
  readonly jobKey: string;
  readonly params: {
    readonly limits: { maxBytes: number; maxDurationMs: number; timeoutMs: number };
    readonly window?: { maxMs: number; startMs?: number; policy: string };
  };
}

function enqueued(h: ReturnType<typeof harness>, index = 0): EnqueuedAcquire {
  const calls = h.jobs.enqueue.mock.calls as unknown as Array<[EnqueuedAcquire]>;
  const call = calls.at(index);
  if (call === undefined) throw new Error(`no enqueue #${String(index)}`);
  return call[0];
}

function createdRunData(h: ReturnType<typeof harness>): Record<string, unknown> {
  const calls = h.prisma.repurposeRun.create.mock.calls as unknown as Array<
    [{ data: Record<string, unknown> }]
  >;
  return calls[0]?.[0].data ?? {};
}

describe("affordableWindowMs — the window a balance pays for, file slack included", () => {
  it("gives exactly 20 credits 19:45: the landed file may run 15 s over and is charged on its length", () => {
    expect(affordableWindowMs(200)).toBe(19 * MINUTE + 45_000);
  });

  it("never sizes a window whose longest file the balance could not pay for", () => {
    for (const tenths of [10, 57, 200, 203, 1_234, 3_000]) {
      const windowMs = affordableWindowMs(tenths);
      if (windowMs > 0) {
        expect(quoteTranscription(windowMs + 15_000).tenths, String(tenths)).toBeLessThanOrEqual(
          tenths,
        );
      }
    }
  });

  it("is nothing for nothing, and for a balance that is not a number", () => {
    expect(affordableWindowMs(0)).toBe(0);
    expect(affordableWindowMs(-50)).toBe(0);
    expect(affordableWindowMs(Number.NaN)).toBe(0);
    // One credit pays for a minute of file, which leaves 45 s of window.
    expect(affordableWindowMs(10)).toBe(45_000);
  });
});

describe("runWindowMs — the plan's window, cut to the balance and the enqueued cap", () => {
  it("is the plan's window when both cover it", () => {
    expect(
      runWindowMs({ clipsWindowMs: 20 * MINUTE, balanceTenths: 100_000, enqueuedCapTenths: 300 }),
    ).toBe(20 * MINUTE);
  });

  it("is what the balance pays for when that is less", () => {
    expect(
      runWindowMs({ clipsWindowMs: 20 * MINUTE, balanceTenths: 100, enqueuedCapTenths: 300 }),
    ).toBe(9 * MINUTE + 45_000);
  });

  it("never exceeds what admission would take as one transcription", () => {
    // A Free lane (300 tenths) under a 6-hour allowance: a bigger window would
    // download fine and then be refused its transcription for good.
    expect(
      runWindowMs({ clipsWindowMs: 6 * HOUR, balanceTenths: 100_000_000, enqueuedCapTenths: 300 }),
    ).toBe(29 * MINUTE + 45_000);
  });
});

describe("create — a link is processed a window at a time", () => {
  it("asks for the plan's window from the most-replayed part, and a 12-hour source ceiling", async () => {
    const h = harness({
      entitlements: { clipsWindowMs: 20 * MINUTE, maxFileBytes: 500 * 1024 ** 2 },
    });
    await h.service.create(WS, USER, linkRun());

    const job = enqueued(h);
    expect(job.type).toBe("media.acquire");
    expect(job.params.window).toEqual({ maxMs: 20 * MINUTE, policy: "most_replayed" });
    // The ceiling, not the upload cap: a 35-minute podcast is cut to the
    // window, never refused for being longer than it.
    expect(job.params.limits.maxDurationMs).toBe(12 * HOUR);
    expect(job.params.limits.maxBytes).toBe(500 * 1024 ** 2);
    expect(createdRunData(h)).toMatchObject({ windowPolicy: "most_replayed" });
    expect(createdRunData(h)).not.toHaveProperty("windowStartMs");
  });

  it("takes a start the person picked as a range, and keys the run on it", async () => {
    const h = harness();
    await h.service.create(WS, USER, linkRun({ window: { startMs: 600_000 } }));

    expect(enqueued(h).params.window).toEqual({
      maxMs: 20 * MINUTE,
      startMs: 600_000,
      policy: "range",
    });
    expect(createdRunData(h)).toMatchObject({ windowPolicy: "range", windowStartMs: 600_000 });
  });

  it("takes the start of the video when asked", async () => {
    const h = harness();
    await h.service.create(WS, USER, linkRun({ window: { policy: "first" } }));
    expect(enqueued(h).params.window).toEqual({ maxMs: 20 * MINUTE, policy: "first" });
  });

  it("processes only what the balance pays for", async () => {
    const h = harness({ balanceTenths: 100 });
    await h.service.create(WS, USER, linkRun());
    expect(enqueued(h).params.window?.maxMs).toBe(9 * MINUTE + 45_000);
  });

  it("refuses with 402 and the credits left, before anything exists, below one minute", async () => {
    const h = harness({ balanceTenths: 5 });
    const refused = (await h.service
      .create(WS, USER, linkRun())
      .catch((error: unknown) => error)) as AppException;

    expect(refused).toBeInstanceOf(AppException);
    expect(refused.code).toBe("repurpose/no_credits");
    expect(refused.httpStatus).toBe(HttpStatus.PAYMENT_REQUIRED);
    expect(refused.details).toEqual({ creditsLeft: 0.5 });
    expect(h.projects.create).not.toHaveBeenCalled();
    expect(h.prisma.repurposeRun.create).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("reads a workspace with no credit account as having none", async () => {
    const h = harness({ balanceTenths: null });
    await expect(h.service.create(WS, USER, linkRun())).rejects.toMatchObject({
      code: "repurpose/no_credits",
      details: { creditsLeft: 0 },
    });
  });

  it("sizes the window by the plan admission control will apply, the subscription's", async () => {
    const studio = harness({
      subscriptionPlan: "studio",
      entitlements: { clipsWindowMs: 6 * HOUR },
      balanceTenths: 100_000,
    });
    await studio.service.create(WS, USER, linkRun());
    expect(enqueued(studio).params.window?.maxMs).toBe(6 * HOUR);

    // The same allowance on a Free lane (a week pass raises the entitlement,
    // never admission's cap) is cut to what one Free transcription may hold.
    const free = harness({ entitlements: { clipsWindowMs: 6 * HOUR }, balanceTenths: 100_000 });
    await free.service.create(WS, USER, linkRun());
    expect(enqueued(free).params.window?.maxMs).toBe(29 * MINUTE + 45_000);
  });

  it("carries at most what the download contract can hold for an unlimited workspace", async () => {
    const h = harness({
      subscriptionPlan: "studio",
      entitlements: {
        clipsWindowMs: 12 * HOUR,
        maxSourceDurationMs: 12 * HOUR,
        maxFileBytes: 50 * 1024 ** 3,
      },
      balanceTenths: 100_000_000,
    });
    await h.service.create(WS, USER, linkRun());
    const job = enqueued(h);
    expect(job.params.limits.maxBytes).toBe(10_000_000_000);
    expect(job.params.limits.maxDurationMs).toBe(12 * HOUR);
    expect(job.params.window?.maxMs).toBe(12 * HOUR);
  });

  it("does not ask an upload for credits: its length is not known until its probe", async () => {
    const h = harness({ balanceTenths: 0 });
    await h.service.create(WS, USER, {
      source: {
        kind: "upload",
        filename: "talk.mp4",
        mime: "video/mp4",
        sizeBytes: 1_000,
        issueUploadTicket: false,
      },
      setup: {
        sourceLanguage: "auto",
        caption: { styleId: "punch-pop" },
        discovery: { mode: "ai", requestedCandidates: 5 },
      },
    } as never);
    expect(h.prisma.creditAccount.findUnique).not.toHaveBeenCalled();
    expect(createdRunData(h)).not.toHaveProperty("windowPolicy");
  });

  it("freezes 'auto' as the spoken language for detection to decide", async () => {
    const h = harness();
    await h.service.create(WS, USER, linkRun());
    expect(h.projects.create).toHaveBeenCalledWith(
      WS,
      USER,
      expect.objectContaining({ sourceLanguage: "auto" }),
    );
    expect(createdRunData(h)).toMatchObject({ config: { sourceLanguage: "auto" } });
  });

  it("lets a picked start run beside the video's other windows", async () => {
    // The duplicate check for a picked start only matches a live run at that
    // start, or one whose start is not known yet.
    const h = harness();
    await h.service.create(WS, USER, linkRun({ window: { startMs: 600_000 } }));
    const lookup = h.prisma.repurposeRun.findFirst.mock.calls.find(
      (call) => "sourceFingerprint" in (call[0] as { where: object }).where,
    )?.[0] as { where: Record<string, unknown> };
    expect(lookup.where["OR"]).toEqual([{ windowStartMs: 600_000 }, { windowStartMs: null }]);
  });

  it("still refuses the same link pasted twice, whatever window the live run has", async () => {
    const h = harness({ liveRunForLink: { id: OTHER_RUN } });
    await expect(h.service.create(WS, USER, linkRun())).rejects.toMatchObject({
      code: "repurpose/source_already_running",
      details: { existingRunId: OTHER_RUN },
    });
    const lookup = h.prisma.repurposeRun.findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(lookup.where).not.toHaveProperty("OR");
  });
});

describe("reacquire — a fetch after the first gets a window too", () => {
  function withProject(h: ReturnType<typeof harness>): void {
    Object.assign(h.prisma, {
      project: {
        findFirst: vi.fn(async () => ({ id: PROJECT, workspaceId: WS, status: "active" })),
      },
    });
  }

  it("fetches a window of a video an older run failed as too long for the plan", async () => {
    // Before windows, a 35-minute video on Free failed `source_too_long`. Its
    // row has no window policy at all; the retry fetches the default window.
    const h = harness();
    withProject(h);
    await h.service.reacquire(
      runRow({ status: "draft" }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );

    const job = enqueued(h);
    expect(job.params.window).toEqual({ maxMs: 20 * MINUTE, policy: "most_replayed" });
    expect(job.params.limits.maxDurationMs).toBe(12 * HOUR);
  });

  it("keeps a picked start picked", async () => {
    const h = harness();
    withProject(h);
    await h.service.reacquire(
      runRow({ windowPolicy: "range", windowStartMs: 1_200_000 }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(enqueued(h).params.window).toEqual({
      maxMs: 20 * MINUTE,
      startMs: 1_200_000,
      policy: "range",
    });
  });

  it("refuses with 402 when the balance no longer pays for a minute", async () => {
    const h = harness({ balanceTenths: 0 });
    withProject(h);
    await expect(
      h.service.reacquire(runRow(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).rejects.toMatchObject({ code: "repurpose/no_credits" });
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("cuts a range to what is left of a video whose length this run measured", async () => {
    const h = harness();
    withProject(h);
    await h.service.reacquire(
      runRow({ windowPolicy: "range", windowStartMs: 465_000, sourceDurationMs: 900_000 }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(enqueued(h).params.window).toEqual({
      maxMs: 435_000,
      startMs: 465_000,
      policy: "range",
    });
  });

  it("cuts it by an earlier run's measurement when this one never landed", async () => {
    // The next window's own run failed before its download reported anything;
    // the window before it measured the video.
    const h = harness({ liveRunForLink: { id: OTHER_RUN, sourceDurationMs: 900_000 } as never });
    withProject(h);
    await h.service.reacquire(
      runRow({ windowPolicy: "range", windowStartMs: 465_000 }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(enqueued(h).params.window?.maxMs).toBe(435_000);
    const lookup = h.prisma.repurposeRun.findFirst.mock.calls.find(
      (call) => "sourceDurationMs" in (call[0] as { where: object }).where,
    )?.[0] as { where: Record<string, unknown> };
    expect(lookup.where).toMatchObject({
      workspaceId: WS,
      sourceFingerprint: "youtube:dQw4w9WgXcQ",
      sourceDurationMs: { not: null },
    });
  });

  it("does not count its own earlier window against the balance", async () => {
    const h = harness();
    withProject(h);
    await h.service.reacquire(runRow(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const pending = h.prisma.repurposeRun.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(pending[0].where).toMatchObject({ workspaceId: WS, id: { not: RUN } });
  });
});

describe("acquireWindowMaxMs — a range never reaches past the source's end", () => {
  it("is the budget for anything but a range from past 0:00", () => {
    expect(acquireWindowMaxMs(20 * MINUTE, { policy: "most_replayed" })).toBe(20 * MINUTE);
    expect(acquireWindowMaxMs(20 * MINUTE, { policy: "first", sourceDurationMs: MINUTE })).toBe(
      20 * MINUTE,
    );
    expect(
      acquireWindowMaxMs(20 * MINUTE, { policy: "range", startMs: 0, sourceDurationMs: MINUTE }),
    ).toBe(20 * MINUTE);
  });

  it("is what is left after the start, when that is less than the budget", () => {
    expect(
      acquireWindowMaxMs(20 * MINUTE, {
        policy: "range",
        startMs: 465_000,
        sourceDurationMs: 900_000,
      }),
    ).toBe(435_000);
    // More than the budget left: the budget.
    expect(
      acquireWindowMaxMs(20 * MINUTE, {
        policy: "range",
        startMs: 465_000,
        sourceDurationMs: HOUR,
      }),
    ).toBe(20 * MINUTE);
  });

  it("leaves an unknown length, or a start at or past the end, to the downloader", () => {
    expect(acquireWindowMaxMs(20 * MINUTE, { policy: "range", startMs: 465_000 })).toBe(
      20 * MINUTE,
    );
    expect(
      acquireWindowMaxMs(20 * MINUTE, {
        policy: "range",
        startMs: 900_000,
        sourceDurationMs: 900_000,
      }),
    ).toBe(20 * MINUTE);
  });

  it("never asks for more than the contract carries", () => {
    expect(acquireWindowMaxMs(48 * HOUR, { policy: "first" })).toBe(24 * HOUR);
  });
});

describe("the download's timeout grows with its window", () => {
  it("keeps forty minutes for a Free window and gives a long one up to the contract's hour", () => {
    expect(acquireTimeoutMs(20 * MINUTE)).toBe(40 * MINUTE);
    expect(acquireTimeoutMs(60 * MINUTE)).toBe(40 * MINUTE);
    expect(acquireTimeoutMs(80 * MINUTE)).toBe(50 * MINUTE);
    expect(acquireTimeoutMs(100 * MINUTE)).toBe(HOUR);
    expect(acquireTimeoutMs(6 * HOUR)).toBe(HOUR);
    expect(acquireTimeoutMs(Number.NaN)).toBe(40 * MINUTE);
  });

  it("sends the timeout for the window the payload asks for", async () => {
    const free = harness();
    await free.service.create(WS, USER, linkRun());
    expect(enqueued(free).params.limits.timeoutMs).toBe(40 * MINUTE);

    const studio = harness({
      subscriptionPlan: "studio",
      entitlements: { clipsWindowMs: 6 * HOUR },
      balanceTenths: 100_000,
    });
    await studio.service.create(WS, USER, linkRun());
    expect(enqueued(studio).params.limits.timeoutMs).toBe(HOUR);
  });
});

describe("the balance other link runs will still need is counted off first", () => {
  const OTHER_PROJECT = "01JCPR0JECT00000000000000B";

  /**
   * One other live link run, on its way to its transcription: what its source
   * project has so far.
   */
  function withPending(
    h: ReturnType<typeof harness>,
    other: {
      readonly windowMaxMs?: number;
      readonly media?: { status: string; durationMs: number | null } | null;
      readonly transcript?: boolean;
      readonly transcribing?: boolean;
    },
  ): void {
    h.prisma.repurposeRun.findMany.mockResolvedValueOnce([
      { sourceProjectId: OTHER_PROJECT } as never,
    ]);
    Object.assign(h.prisma.transcript, {
      findMany: vi.fn(async () =>
        other.transcript === true ? [{ projectId: OTHER_PROJECT }] : [],
      ),
    });
    Object.assign(h.prisma.mediaAsset, {
      findMany: vi.fn(async () =>
        other.media === undefined || other.media === null
          ? []
          : [{ projectId: OTHER_PROJECT, ...other.media }],
      ),
    });
    h.prisma.job.findMany.mockImplementation((async (args: { where: { type: unknown } }) => {
      if (args.where.type === "media.acquire") {
        return other.windowMaxMs === undefined
          ? []
          : [
              {
                projectId: OTHER_PROJECT,
                params: {
                  schemaVersion: 1,
                  runId: OTHER_RUN,
                  projectId: OTHER_PROJECT,
                  mediaId: MEDIA,
                  source: {
                    kind: "youtube_url",
                    normalizedUrl: "https://www.youtube.com/watch?v=aDpIra7NFuE",
                    sourceId: "youtube:aDpIra7NFuE",
                  },
                  destination: { bucket: "s3", key: "k" },
                  limits: { maxBytes: 1, maxDurationMs: 1, timeoutMs: 1 },
                  window: { maxMs: other.windowMaxMs, policy: "most_replayed" },
                },
              },
            ];
      }
      return other.transcribing === true ? [{ projectId: OTHER_PROJECT }] : [];
    }) as never);
  }

  it("refuses the second of two links pasted back to back on 20 credits", async () => {
    // The first run is still downloading its 19:45; its transcription will take
    // all 20 credits. The second used to get 19:45 too, download it, and fail
    // `no_credits` at transcription.
    const h = harness({ balanceTenths: 200 });
    withPending(h, { windowMaxMs: 19 * MINUTE + 45_000 });

    const refused = (await h.service
      .create(WS, USER, linkRun())
      .catch((error: unknown) => error)) as AppException;
    expect(refused.code).toBe("repurpose/no_credits");
    expect(refused.details).toEqual({ creditsLeft: 0 });
    expect(refused.message).toMatch(/already fetching need 20 of them/);
    expect(h.projects.create).not.toHaveBeenCalled();
  });

  it("sizes the window from what is left once the other run is paid for", async () => {
    const h = harness({ balanceTenths: 300 });
    withPending(h, { windowMaxMs: 9 * MINUTE + 45_000 });
    await h.service.create(WS, USER, linkRun());
    // 30 credits, 10 of them for the other run: 20 left, 19:45 of window.
    expect(enqueued(h).params.window?.maxMs).toBe(19 * MINUTE + 45_000);
  });

  it("counts a probed file at its real length rather than its window", async () => {
    const h = harness({ balanceTenths: 300 });
    withPending(h, {
      windowMaxMs: 19 * MINUTE + 45_000,
      media: { status: "ready", durationMs: 4 * MINUTE },
    });
    await h.service.create(WS, USER, linkRun());
    expect(enqueued(h).params.window?.maxMs).toBe(20 * MINUTE);
  });

  it.each([
    ["has a transcript", { transcript: true }],
    ["has its transcription queued (its hold is already off the balance)", { transcribing: true }],
    ["failed its download", { media: { status: "failed", durationMs: null } }],
  ])("does not count a run that %s", async (_label, state) => {
    const h = harness({ balanceTenths: 200 });
    withPending(h, { windowMaxMs: 19 * MINUTE + 45_000, ...state });
    await h.service.create(WS, USER, linkRun());
    expect(enqueued(h).params.window?.maxMs).toBe(19 * MINUTE + 45_000);
  });

  it("only looks at live link runs of this workspace", async () => {
    const h = harness();
    await h.service.create(WS, USER, linkRun());
    const pending = h.prisma.repurposeRun.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(pending[0].where).toEqual({
      workspaceId: WS,
      sourceKind: { not: "upload" },
      status: { in: ["draft", "acquiring", "preparing_media", "transcribing", "analyzing"] },
    });
  });
});

describe("pendingQuoteTenths", () => {
  it("is the file's quote, else the window's with its slack, else nothing", () => {
    expect(
      pendingQuoteTenths({ mediaStatus: "ready", mediaDurationMs: 60_000, windowMaxMs: HOUR }),
    ).toBe(quoteTranscription(60_000).tenths);
    expect(
      pendingQuoteTenths({ mediaStatus: "pending", mediaDurationMs: null, windowMaxMs: 45_000 }),
    ).toBe(quoteTranscription(60_000).tenths);
    expect(
      pendingQuoteTenths({ mediaStatus: null, mediaDurationMs: null, windowMaxMs: null }),
    ).toBe(0);
    expect(
      pendingQuoteTenths({ mediaStatus: "failed", mediaDurationMs: 60_000, windowMaxMs: HOUR }),
    ).toBe(0);
  });
});

describe("nextWindow — process the next part of a long video", () => {
  const LANDED = {
    status: "candidates_ready",
    windowStartMs: 730_000,
    windowEndMs: 1_930_000,
    windowPolicy: "most_replayed",
    sourceDurationMs: 3 * HOUR,
    rightsAttestedAt: new Date("2026-09-27T06:00:00Z"),
    rightsAttestedBy: USER,
    config: {
      schemaVersion: 1,
      sourceLanguage: "hi-Latn",
      caption: {
        outputLanguage: "same",
        scriptMode: "roman",
        styleId: "punch-pop",
        styleVersion: 1,
      },
      discovery: {
        mode: "ai",
        requestedCandidates: 8,
        minDurationMs: 15_000,
        maxDurationMs: 60_000,
        contentGoal: "reach",
      },
    },
  } as const;

  it("starts a NEW run where this window ended, with this run's settings", async () => {
    const h = harness({ run: runRow(LANDED as never) });
    const answer = await h.service.nextWindow(WS, "01JCUSER00000000000000000B", RUN);

    expect(enqueued(h).params.window).toEqual({
      maxMs: 20 * MINUTE,
      startMs: 1_930_000,
      policy: "range",
    });
    expect(createdRunData(h)).toMatchObject({
      windowStartMs: 1_930_000,
      windowPolicy: "range",
      requestedCandidates: 8,
      // The same video, under the attestation its first window was fetched with.
      rightsAttestedAt: LANDED.rightsAttestedAt,
      rightsAttestedBy: USER,
      config: {
        sourceLanguage: "hi-Latn",
        caption: { styleId: "punch-pop", scriptMode: "roman", styleVersion: 1 },
      },
    });
    expect(answer.run.id).toBeDefined();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "repurpose.run.created",
        data: expect.objectContaining({ nextWindowOf: RUN, windowStartMs: 1_930_000 }),
      }),
    );
  });

  it("answers with the live run already over that start, rather than a second download", async () => {
    const h = harness({ run: runRow(LANDED as never), liveRunForLink: { id: OTHER_RUN } });
    await h.service.nextWindow(WS, USER, RUN);

    expect(h.prisma.repurposeRun.create).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    const exact = h.prisma.repurposeRun.findFirst.mock.calls.find(
      (call) => "sourceFingerprint" in (call[0] as { where: object }).where,
    )?.[0] as { where: Record<string, unknown> };
    expect(exact.where).toMatchObject({ windowStartMs: 1_930_000 });
  });

  it("answers with the winner when a second press wins the race to the index", async () => {
    const h = harness({
      run: runRow(LANDED as never),
      // Not there at the first look; there after the index refused this one.
      liveRunForLink: [null, { id: OTHER_RUN }, { id: OTHER_RUN }],
    });
    h.prisma.repurposeRun.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const answer = await h.service.nextWindow(WS, USER, RUN);
    expect(answer.run).toBeDefined();
    expect(h.projects.softDelete).toHaveBeenCalledWith(WS, PROJECT);
  });

  it.each([
    ["an upload", { sourceKind: "upload", sourceFingerprint: null }, /YouTube link/],
    [
      "a window that has not landed",
      { status: "draft", windowStartMs: null, windowEndMs: null, sourceDurationMs: null },
      /still being fetched/,
    ],
    [
      "a video processed whole",
      { windowStartMs: null, windowEndMs: null, sourceDurationMs: 10 * MINUTE },
      /no recorded part of the video/,
    ],
    [
      // Finished days ago, before windows were recorded: nothing is being fetched.
      "a run from before windows",
      { windowStartMs: null, windowEndMs: null, windowPolicy: null, sourceDurationMs: null },
      /no recorded part of the video/,
    ],
    [
      "a failed run whose part never landed",
      {
        status: "failed",
        failureCode: "repurpose/source_blocked",
        windowStartMs: null,
        windowEndMs: null,
        sourceDurationMs: null,
      },
      /no recorded part of the video/,
    ],
    [
      "a window that reached the end",
      { windowEndMs: 3 * HOUR - 10_000 },
      /nothing left after 2:59:50 of this 3:00:00 video/,
    ],
  ])("answers 409 no_next_window for %s", async (_label, overrides, message) => {
    const h = harness({ run: runRow({ ...LANDED, ...overrides } as never) });
    const refused = (await h.service
      .nextWindow(WS, USER, RUN)
      .catch((error: unknown) => error)) as AppException;

    expect(refused.code).toBe("repurpose/no_next_window");
    expect(refused.httpStatus).toBe(HttpStatus.CONFLICT);
    expect(refused.message).toMatch(message);
    expect(h.prisma.repurposeRun.create).not.toHaveBeenCalled();
  });

  it("says a landed download whose part was not recorded is not still being fetched", async () => {
    // The run's section write lost the start to another live run of the video:
    // its media landed (and is being prepared), but it has no window to follow.
    const h = harness({
      run: runRow({ ...LANDED, status: "draft", windowEndMs: null } as never),
      media: { id: MEDIA, status: "ready", failureReason: null, uploadedAt: new Date() },
    });
    await expect(h.service.nextWindow(WS, USER, RUN)).rejects.toMatchObject({
      code: "repurpose/no_next_window",
      message: expect.stringMatching(/no recorded part of the video/),
    });
  });

  it("cuts the next window to what is left of the video, so the download is a section", async () => {
    // 15 minutes; the first window (8 credits) covered 0:00-7:45. With a full
    // budget of 20 minutes the next asks for 7:15 from 7:45, not 20 minutes:
    // the downloader fetches a source that fits its window whole from 0:00,
    // which re-charged the first 7:45 and duplicated its moments.
    const h = harness({
      run: runRow({
        ...LANDED,
        windowStartMs: 0,
        windowEndMs: 465_000,
        windowPolicy: "first",
        sourceDurationMs: 900_000,
      } as never),
    });
    await h.service.nextWindow(WS, USER, RUN);

    expect(enqueued(h).params.window).toEqual({
      maxMs: 435_000,
      startMs: 465_000,
      policy: "range",
    });
  });

  it("keeps the first attestation on the row and says in the audit whose it is", async () => {
    const PRESSER = "01JCUSER00000000000000000B";
    const h = harness({ run: runRow(LANDED as never) });
    await h.service.nextWindow(WS, PRESSER, RUN);

    // The row: who attested and when - never the presser, who attested nothing.
    expect(createdRunData(h)).toMatchObject({
      rightsAttestedBy: USER,
      rightsAttestedAt: LANDED.rightsAttestedAt,
      createdBy: PRESSER,
    });
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: PRESSER,
        data: expect.objectContaining({
          nextWindowOf: RUN,
          rightsAttestedBy: USER,
          rightsAttestedAt: LANDED.rightsAttestedAt.toISOString(),
          rightsAttestationOf: RUN,
        }),
      }),
    );
  });

  it("refuses with 402 before making anything when the balance does not pay for a minute", async () => {
    const h = harness({ run: runRow(LANDED as never), balanceTenths: 3 });
    await expect(h.service.nextWindow(WS, USER, RUN)).rejects.toMatchObject({
      code: "repurpose/no_credits",
    });
    expect(h.projects.create).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's run", async () => {
    const h = harness({ run: runRow(LANDED as never) });
    await expect(
      h.service.nextWindow("01JCWS0000000000000000000B", USER, RUN),
    ).rejects.toMatchObject({ code: "repurpose/not_found" });
  });
});

describe("retry — the next window of the same video does not block this one", () => {
  it("looks for a clash at this run's own start only", async () => {
    const h = harness({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/stage_timeout",
        windowStartMs: 730_000,
      }),
    });
    await h.service.retry(WS, USER, RUN);
    const lookup = h.prisma.repurposeRun.findFirst.mock.calls.find(
      (call) => "sourceFingerprint" in (call[0] as { where: object }).where,
    )?.[0] as { where: Record<string, unknown> };
    expect(lookup.where).toMatchObject({
      id: { not: RUN },
      OR: [{ windowStartMs: 730_000 }, { windowStartMs: null }],
    });
  });
});

describe("failRun — the numbers go with the failure", () => {
  function written(h: ReturnType<typeof harness>): Record<string, unknown> {
    const calls = h.prisma.repurposeRun.updateMany.mock.calls as unknown as Array<
      [{ data: Record<string, unknown> }]
    >;
    return calls[0]?.[0].data ?? {};
  }

  it("writes the numbers it is given", async () => {
    const h = harness();
    await h.service.failRun(h.current(), "repurpose/source_too_long", "getting_video", {
      durationMs: 2_077_000,
      maxDurationMs: 1_200_000,
    });
    expect(written(h)).toMatchObject({
      status: "failed",
      failureDetail: { durationMs: 2_077_000, maxDurationMs: 1_200_000 },
    });
  });

  it("clears the column when told there are none", async () => {
    const h = harness();
    await h.service.failRun(h.current(), "repurpose/source_blocked", "getting_video", null);
    expect(written(h)["failureDetail"]).toBe(Prisma.DbNull);
  });

  it("says how many credits are left for no_credits", async () => {
    const h = harness({ balanceTenths: 37 });
    await h.service.failRun(h.current(), "repurpose/no_credits", "finding_clips");
    expect(written(h)["failureDetail"]).toEqual({ creditsLeft: 3.7 });
  });

  it("keeps what the probe put there for source_too_long", async () => {
    const h = harness();
    await h.service.failRun(h.current(), "repurpose/source_too_long", "getting_video");
    expect(written(h)).not.toHaveProperty("failureDetail");
  });

  it("clears an earlier failure's numbers under any other code", async () => {
    const h = harness();
    await h.service.failRun(h.current(), "repurpose/transcription_failed", "finding_clips");
    expect(written(h)["failureDetail"]).toBe(Prisma.DbNull);
  });

  it("attaches late numbers only to the failure they explain", async () => {
    const h = harness();
    await h.service.recordFailureDetail(RUN, "repurpose/source_too_large", { maxBytes: 1 });
    expect(h.prisma.repurposeRun.updateMany).toHaveBeenCalledWith({
      where: { id: RUN, status: "failed", failureCode: "repurpose/source_too_large" },
      data: { failureDetail: { maxBytes: 1 } },
    });
  });
});

describe("the run's view — title, window, failure numbers, next window", () => {
  it("shows the real title and the part of the source that landed", async () => {
    const h = harness({
      run: runRow({
        status: "candidates_ready",
        sourceTitle: "A talk",
        windowStartMs: 730_000,
        windowEndMs: 1_930_000,
        windowPolicy: "most_replayed",
        sourceDurationMs: 3 * HOUR,
      }),
    });
    const view = await h.service.get(WS, RUN);
    expect(view.sourceTitle).toBe("A talk");
    expect(view.window).toEqual({
      startMs: 730_000,
      endMs: 1_930_000,
      sourceDurationMs: 3 * HOUR,
      policy: "most_replayed",
    });
    expect(view.nextWindowAvailable).toBe(true);
    expect(view.failureDetail).toBeNull();
  });

  it("shows no window for a video processed whole, and nothing after it", async () => {
    const h = harness({
      run: runRow({ status: "candidates_ready", sourceDurationMs: 10 * MINUTE }),
    });
    const view = await h.service.get(WS, RUN);
    expect(view.window).toBeNull();
    expect(view.nextWindowAvailable).toBe(false);
  });

  it("shows the numbers only while the run is failed", async () => {
    const failed = harness({
      run: runRow({
        status: "failed",
        failureCode: "repurpose/source_too_large",
        failureDetail: { maxBytes: 524_288_000, approximateBytes: 900_000_000, junk: "x" },
      }),
    });
    expect((await failed.service.get(WS, RUN)).failureDetail).toEqual({
      maxBytes: 524_288_000,
      approximateBytes: 900_000_000,
    });

    // Retried since: the column is still there until the next failure, and must not show.
    const retried = harness({
      run: runRow({ status: "analyzing", failureDetail: { maxBytes: 524_288_000 } }),
    });
    expect((await retried.service.get(WS, RUN)).failureDetail).toBeNull();
  });
});

describe("discovery reasons in the language the transcript turned out to be", () => {
  it("uses the transcript's language over the form's pick", async () => {
    const h = harness({
      run: runRow({ status: "transcribing", config: { sourceLanguage: "hi-Latn", discovery: {} } }),
      transcriptLanguage: "en",
    });
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    const calls = h.jobs.enqueue.mock.calls as unknown as Array<
      [{ params: { options: { language: string } } }]
    >;
    expect(calls[0]?.[0].params.options.language).toBe("en");
  });

  it("never hands 'auto' to discovery", () => {
    expect(discoveryLanguage("hi-Latn", "auto")).toBe("hi-Latn");
    expect(discoveryLanguage(undefined, "auto")).toBe("en");
    expect(discoveryLanguage("auto", "hi")).toBe("hi");
    expect(discoveryLanguage(" ", undefined)).toBe("en");
    expect(discoveryLanguage(null, "en-IN")).toBe("en-IN");
  });
});

describe("steering (2026-09-29): topic, clip length and skipped start and end", () => {
  type Options = {
    count: number;
    minDurationMs: number;
    maxDurationMs: number;
    topic?: string;
    excludeRanges?: Array<{ startMs: number; endMs: number }>;
    minPotential?: number;
  };
  function discoveryOptions(h: ReturnType<typeof harness>): Options {
    const calls = h.jobs.enqueue.mock.calls as unknown as Array<[{ params: { options: Options } }]>;
    const options = calls[0]?.[0].params.options;
    if (options === undefined) throw new Error("discovery was not enqueued");
    return options;
  }
  const steered = {
    mode: "ai",
    requestedCandidates: 5,
    topic: "money habits, startup failures",
    clipLength: "short",
    skipIntroMs: 2 * MINUTE,
    skipOutroMs: MINUTE,
  };

  it("freezes the steering with the run, the length preset written into its bounds", async () => {
    const h = harness();
    const created = await h.service.create(
      WS,
      USER,
      linkRun({
        discovery: { ...steered, minDurationMs: 15_000, maxDurationMs: 60_000 },
      }),
    );
    const config = createdRunData(h)["config"] as { discovery: Record<string, unknown> };
    expect(config.discovery).toMatchObject({
      topic: "money habits, startup failures",
      clipLength: "short",
      minDurationMs: 15_000,
      maxDurationMs: 35_000,
      skipIntroMs: 2 * MINUTE,
      skipOutroMs: MINUTE,
    });
    // And the page reads it back: "About: money habits · Short clips".
    expect(created.run.steering).toEqual({
      topic: "money habits, startup failures",
      clipLength: "short",
      skipIntroMs: 2 * MINUTE,
      skipOutroMs: MINUTE,
    });
  });

  it("sends discovery the length band, the topic and the skips on the file's clock", async () => {
    const h = harness({
      run: runRow({ status: "transcribing", config: { sourceLanguage: "en", discovery: steered } }),
      media: { id: MEDIA, status: "ready", durationMs: 20 * MINUTE, sourceOffsetMs: 0 },
    });
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    expect(discoveryOptions(h)).toMatchObject({
      minDurationMs: 15_000,
      maxDurationMs: 35_000,
      topic: "money habits, startup failures",
      excludeRanges: [
        { startMs: 0, endMs: 2 * MINUTE },
        { startMs: 19 * MINUTE, endMs: 20 * MINUTE },
      ],
    });
  });

  it("places the skips in the video, not in a window of it", async () => {
    // 20:00-40:00 of a 45-minute video: the intro is long over, the last ten
    // minutes (from 35:00) are 15:00-20:00 of this file.
    const h = harness({
      run: runRow({
        status: "transcribing",
        windowStartMs: 20 * MINUTE,
        windowEndMs: 40 * MINUTE,
        sourceDurationMs: 45 * MINUTE,
        config: {
          sourceLanguage: "en",
          discovery: { ...steered, skipOutroMs: 10 * MINUTE },
        },
      }),
      media: { id: MEDIA, status: "ready", durationMs: 20 * MINUTE, sourceOffsetMs: 20 * MINUTE },
    });
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    expect(discoveryOptions(h).excludeRanges).toEqual([
      { startMs: 15 * MINUTE, endMs: 20 * MINUTE },
    ]);
  });

  it("asks exactly what it asked before for a run that was not steered", async () => {
    const h = harness({
      run: runRow({ status: "transcribing" }),
      media: { id: MEDIA, status: "ready", durationMs: 20 * MINUTE },
    });
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    const options = discoveryOptions(h);
    expect(options).toMatchObject({ count: 5, minDurationMs: 15_000, maxDurationMs: 60_000 });
    expect(options).not.toHaveProperty("topic");
    expect(options).not.toHaveProperty("excludeRanges");
  });

  it("asks Autopilot's discovery for a reserve on top of the clips it will cut", async () => {
    const h = harness({
      run: runRow({
        status: "transcribing",
        config: { sourceLanguage: "en", automation: "auto", discovery: { mode: "ai" } },
      }),
      media: { id: MEDIA, status: "ready", durationMs: 20 * MINUTE },
    });
    await h.service.startHighlightDiscovery(h.current(), TRANSCRIPT);
    // Twenty minutes: ten clips, and three more in reserve.
    expect(discoveryOptions(h)).toMatchObject({ count: 13, minPotential: 0.6 });
  });

  it("keeps the steering when the next part of a long video is started", async () => {
    const h = harness({
      run: runRow({
        status: "review_ready",
        windowStartMs: 0,
        windowEndMs: 20 * MINUTE,
        windowPolicy: "first",
        sourceDurationMs: 45 * MINUTE,
        config: {
          sourceLanguage: "en",
          caption: { styleId: "punch-pop", outputLanguage: "same", scriptMode: "auto" },
          discovery: steered,
        },
      }),
    });
    await h.service.nextWindow(WS, USER, RUN);
    const config = createdRunData(h)["config"] as { discovery: Record<string, unknown> };
    expect(config.discovery).toMatchObject({
      topic: "money habits, startup failures",
      clipLength: "short",
      skipIntroMs: 2 * MINUTE,
      skipOutroMs: MINUTE,
    });
  });
});
