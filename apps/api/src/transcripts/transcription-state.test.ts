import { describe, expect, it, vi } from "vitest";

import { TranscriptsService } from "./transcripts.service.js";

import type { TranscriptsRepository } from "./transcripts.repository.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";

/**
 * FIX-03's read model. Every branch is derived from rows that already exist, so
 * the whole surface under test is: transcript? → media? → job? → language?.
 * Mocked are the three lookups the method makes and nothing else — the service's
 * other three dependencies are never reached and are passed `as never`.
 */

const PROJECT: { id: string; workspaceId: string; sourceLanguage: string | null } = {
  id: "01PROJECT",
  workspaceId: "01WORKSPACE",
  sourceLanguage: "hi-Latn",
};

const READY_MEDIA: {
  status: string;
  durationMs: number | null;
  failureReason?: string | null;
  createdAt?: Date;
  id?: string;
  projectId?: string;
  hasAudio?: boolean | null;
  width?: number | null;
  proxyKey?: string | null;
  project?: { workspaceId: string };
} = {
  status: "ready",
  durationMs: 20_200,
};

interface JobRow {
  id: string;
  status: string;
  error?: unknown;
}

/** A row for the `jobs` override, which stands in for a real multi-row table. */
interface TypedJobRow extends JobRow {
  type: string;
  queuedAt: Date;
}

interface Overrides {
  project?: Partial<typeof PROJECT>;
  transcript?: { id: string } | null;
  media?: Partial<typeof READY_MEDIA> | null;
  job?: JobRow | null;
  /**
   * S-06: several job rows, selected the way Postgres would — the `where.type`
   * filter, then newest `queuedAt` first. Use this instead of `job` when the
   * point of the case is WHICH row the read model picks.
   */
  jobs?: readonly TypedJobRow[];
  /** Whether `edg_documents` has a row for the project. */
  document?: { id: string } | null;
  /** What `TranscriptDocumentService.ensure` does when the read model repairs. */
  ensure?: () => Promise<{ status: string; edgId?: string }>;
  /** What `MediaProbeRestart.restart` answers. */
  restarted?: "queued" | "busy" | "failed";
}

function harness(overrides: Overrides = {}) {
  const project = { ...PROJECT, ...overrides.project };
  const media = overrides.media === null ? null : { ...READY_MEDIA, ...overrides.media };
  const job = overrides.job ?? null;
  const jobs = overrides.jobs;

  const findFirstJob = vi.fn(
    async (args: {
      where: { type?: string | { in?: readonly string[] } };
      orderBy?: { queuedAt?: string };
    }) => {
      if (jobs === undefined) return job;
      const filter = args.where.type;
      const types = typeof filter === "string" ? [filter] : (filter?.in ?? []);
      const matching = jobs.filter((row) => types.includes(row.type));
      const ordered = [...matching].sort((a, b) =>
        args.orderBy?.queuedAt === "asc"
          ? a.queuedAt.getTime() - b.queuedAt.getTime()
          : b.queuedAt.getTime() - a.queuedAt.getTime(),
      );
      return ordered[0] ?? null;
    },
  );

  const prisma = {
    project: { findFirst: vi.fn(async () => project) },
    mediaAsset: { findFirst: vi.fn(async () => media) },
    job: { findFirst: findFirstJob },
    edgDocument: { findUnique: vi.fn(async () => overrides.document ?? null) },
  } as unknown as PrismaService;

  const restart = vi.fn(async () => overrides.restarted ?? "queued");
  const ensure = vi.fn(overrides.ensure ?? (async () => ({ status: "created", edgId: "01EDG" })));

  const repository = {
    latest: vi.fn(async () => overrides.transcript ?? null),
  } as unknown as TranscriptsRepository;

  const service = new TranscriptsService(
    prisma,
    repository,
    undefined as never,
    undefined as never,
    undefined as never,
    { ensure } as never,
    { restart } as never,
  );

  return { service, prisma, repository, ensure, restart };
}

const state = async (overrides: Overrides = {}) =>
  harness(overrides).service.transcriptionState("01PROJECT", "01WORKSPACE");

describe("TranscriptsService.transcriptionState", () => {
  // `ready` is the editor's green light, so it needs what the editor loads: the
  // editing document. A transcript alone used to count, and every repurposed
  // clip (transcript cloned, document never built) looped on the waiting screen.
  it("is ready when the transcript has an editing document", async () => {
    const { service, ensure } = harness({
      transcript: { id: "01TRANSCRIPT" },
      document: { id: "01EDG" },
    });
    await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
      status: "ready",
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  describe("a transcript with no editing document", () => {
    it("reports the producer's open job instead of racing its write", async () => {
      const { service, ensure } = harness({
        transcript: { id: "01TRANSCRIPT" },
        job: { id: "01JOB", status: "running" },
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "running",
        jobId: "01JOB",
      });
      expect(ensure).not.toHaveBeenCalled();
    });

    // A clip's transcript is cloned before its video is probed; the document is
    // built on `media.proxy` success, against the probed dimensions.
    it("waits on the media while it is still being prepared", async () => {
      const { service, ensure } = harness({
        transcript: { id: "01TRANSCRIPT" },
        media: { status: "probing" },
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "processing_media",
      });
      expect(ensure).not.toHaveBeenCalled();
    });

    it("builds the document from the stored transcript once the media is ready", async () => {
      const { service, ensure } = harness({ transcript: { id: "01TRANSCRIPT" } });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "ready",
      });
      expect(ensure).toHaveBeenCalledWith("01PROJECT");
    });

    // Every clip cut before 2026-09-25: the mezzanine was stamped `ready` with
    // nothing measured and no preview. Opening it as-is would show "audio only".
    const NEVER_PROBED = {
      id: "01MEDIA",
      projectId: "01PROJECT",
      status: "ready",
      hasAudio: null,
      width: null,
      proxyKey: null,
      project: { workspaceId: "01WORKSPACE" },
    };

    it("sends never-probed media back through the pipeline instead of opening it", async () => {
      const { service, ensure, restart } = harness({
        transcript: { id: "01TRANSCRIPT" },
        media: NEVER_PROBED,
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "processing_media",
      });
      expect(restart).toHaveBeenCalledWith(
        expect.objectContaining({ id: "01MEDIA", projectId: "01PROJECT" }),
        "01WORKSPACE",
      );
      expect(ensure).not.toHaveBeenCalled();
    });

    // A Free workspace allows two jobs in flight; a full lane is temporary.
    it("keeps waiting when the workspace's lane is full, rather than open with no preview", async () => {
      const { service, ensure } = harness({
        transcript: { id: "01TRANSCRIPT" },
        media: NEVER_PROBED,
        restarted: "busy",
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "processing_media",
      });
      expect(ensure).not.toHaveBeenCalled();
    });

    it("still opens the project when the video cannot be probed at all", async () => {
      const { service, ensure } = harness({
        transcript: { id: "01TRANSCRIPT" },
        media: NEVER_PROBED,
        restarted: "failed",
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "ready",
      });
      expect(ensure).toHaveBeenCalledWith("01PROJECT");
    });

    it("does not re-probe media that was probed", async () => {
      const { service, restart } = harness({
        transcript: { id: "01TRANSCRIPT" },
        media: { ...NEVER_PROBED, hasAudio: true, width: 1080, proxyKey: "p/proxy.mp4" },
      });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "ready",
      });
      expect(restart).not.toHaveBeenCalled();
    });

    it("is ready when a concurrent request built the document first", async () => {
      const { service, prisma } = harness({
        transcript: { id: "01TRANSCRIPT" },
        ensure: async () => {
          throw new Error("Unique constraint failed on the fields: (`project_id`)");
        },
      });
      const findUnique = prisma.edgDocument.findUnique as unknown as ReturnType<typeof vi.fn>;
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "01EDG" });
      await expect(service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "ready",
      });
    });

    it("answers failed, never ready, when the document cannot be built", async () => {
      const { service } = harness({
        transcript: { id: "01TRANSCRIPT" },
        ensure: async () => {
          throw new Error("segmenter exploded");
        },
      });
      const view = await service.transcriptionState("01PROJECT", "01WORKSPACE");
      expect(view.status).toBe("failed");
      expect(view.error).toMatch(/editor could not be prepared/);
    });
  });

  it("reports no_media for a project with nothing uploaded", async () => {
    await expect(state({ media: null })).resolves.toEqual({ status: "no_media" });
  });

  // Probing/proxying is not "not transcribed yet": transcription cannot start
  // until the probe has written a duration.
  it("reports processing_media while the probe has not produced a usable duration", async () => {
    await expect(state({ media: { status: "probing" } })).resolves.toEqual({
      status: "processing_media",
    });
    await expect(state({ media: { durationMs: null } })).resolves.toEqual({
      status: "processing_media",
    });
    await expect(state({ media: { durationMs: 0 } })).resolves.toEqual({
      status: "processing_media",
    });
  });

  it("reports failed when media processing failed", async () => {
    await expect(
      state({
        media: {
          status: "failed",
          failureReason: "Unsupported video codec.",
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      error: "Unsupported video codec.",
    });

    await expect(state({ media: { status: "failed", failureReason: null } })).resolves.toEqual({
      status: "failed",
      error: "Media processing failed. Please try re-uploading the file.",
    });
  });

  it("reports failed when media upload or probing timed out", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await expect(
      state({
        media: {
          status: "uploading",
          createdAt: tenMinutesAgo,
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      error: "Media upload or processing timed out. Please try re-uploading the file.",
    });
  });

  it("reports queued, with the job id, while the job waits", async () => {
    const h = harness({ job: { id: "01JOB", status: "queued" } });
    await expect(h.service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
      status: "queued",
      jobId: "01JOB",
    });
    // Scoped to this project's transcription jobs — a render or export job of the
    // same project must never be read as the transcript's progress. S-06 widened
    // the filter to the align queue, and to nothing else.
    expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "01PROJECT", type: { in: ["ai.transcribe", "ai.align"] } },
      }),
    );
  });

  it("reports running while the job executes", async () => {
    await expect(state({ job: { id: "01JOB", status: "running" } })).resolves.toEqual({
      status: "running",
      jobId: "01JOB",
    });
  });

  // `jobs.error` is JSONB `{code, message, retryable}` (JobErrorSchema), so the
  // sentence a user reads is `message`; an unusable value must still say
  // something rather than render "undefined". A cancelled job reads the same way.
  it("reports failed and passes the reason through", async () => {
    await expect(
      state({
        job: {
          id: "01JOB",
          status: "failed",
          error: {
            code: "asr/provider_error",
            message: "The ASR provider timed out.",
            retryable: true,
          },
        },
      }),
    ).resolves.toEqual({
      status: "failed",
      jobId: "01JOB",
      error: "The ASR provider timed out.",
    });

    await expect(state({ job: { id: "01JOB", status: "failed", error: null } })).resolves.toEqual({
      status: "failed",
      jobId: "01JOB",
      error: "The transcription failed.",
    });

    await expect(state({ job: { id: "01JOB", status: "cancelled" } })).resolves.toEqual({
      status: "failed",
      jobId: "01JOB",
      error: "The transcription failed.",
    });
  });

  // The audit's race from the other side: the completion handler has marked the
  // job succeeded and is still writing the transcript. Anything but "running"
  // here flashes an error at a user who is 200 ms from the editor.
  it("still reports running when the job succeeded but no transcript is written yet", async () => {
    await expect(state({ job: { id: "01JOB", status: "succeeded" } })).resolves.toEqual({
      status: "running",
      jobId: "01JOB",
    });
  });

  it("reports awaiting_language when the project has no source language", async () => {
    await expect(state({ project: { sourceLanguage: null } })).resolves.toEqual({
      status: "awaiting_language",
    });
    await expect(state({ project: { sourceLanguage: "   " } })).resolves.toEqual({
      status: "awaiting_language",
    });
  });

  // Media ready, language chosen, no job at all: the auto-start never ran or was
  // refused (a zero-credit workspace lands exactly here). The waiting screen
  // offers the explicit start, and its 402 tells the credit story.
  it("reports not_started when media is ready, a language is chosen and no job exists", async () => {
    await expect(state()).resolves.toEqual({ status: "not_started" });
  });

  // S-06. An imported-subtitles project (S-03) never enqueues `ai.transcribe` at
  // all — its work is an `ai.align`. While the read model looked only at the
  // transcribe queue it answered `not_started` for a live alignment, and the
  // waiting screen polled "Aligning your subtitles…" forever.
  describe("alignment jobs (S-06)", () => {
    const ALIGN: TypedJobRow = {
      id: "01ALIGN",
      status: "queued",
      type: "ai.align",
      queuedAt: new Date("2026-09-05T10:00:00Z"),
    };

    it("reports queued while an ai.align job waits", async () => {
      await expect(state({ jobs: [ALIGN] })).resolves.toEqual({
        status: "queued",
        jobId: "01ALIGN",
      });
    });

    it("reports failed, with the alignment's own message, when the align job failed", async () => {
      await expect(
        state({
          jobs: [
            {
              ...ALIGN,
              status: "failed",
              error: {
                code: "align/no_speech",
                message: "Could not match the subtitles to the audio.",
                retryable: false,
              },
            },
          ],
        }),
      ).resolves.toEqual({
        status: "failed",
        jobId: "01ALIGN",
        error: "Could not match the subtitles to the audio.",
      });
    });

    // The regression pin: widening the filter is only safe because the newest row
    // still wins. A project that failed a transcription in the morning and
    // imported subtitles in the afternoon must read as the import, not the
    // morning's failure.
    it("lets the newest of the two queues win", async () => {
      const h = harness({
        jobs: [
          {
            id: "01TRANSCRIBE",
            status: "failed",
            type: "ai.transcribe",
            queuedAt: new Date("2026-09-05T09:00:00Z"),
            error: { code: "asr/provider_error", message: "Old news.", retryable: true },
          },
          { ...ALIGN, status: "succeeded", queuedAt: new Date("2026-09-05T15:00:00Z") },
        ],
      });

      // Succeeded-but-no-transcript-row is the handler mid-write: keep waiting.
      await expect(h.service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
        status: "running",
        jobId: "01ALIGN",
      });
      expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: "01PROJECT", type: { in: ["ai.transcribe", "ai.align"] } },
          orderBy: { queuedAt: "desc" },
        }),
      );
    });
  });
});
