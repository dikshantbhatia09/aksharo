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

const READY_MEDIA: { status: string; durationMs: number | null } = {
  status: "ready",
  durationMs: 20_200,
};

interface Overrides {
  project?: Partial<typeof PROJECT>;
  transcript?: { id: string } | null;
  media?: Partial<typeof READY_MEDIA> | null;
  job?: { id: string; status: string; error?: unknown } | null;
}

function harness(overrides: Overrides = {}) {
  const project = { ...PROJECT, ...overrides.project };
  const media = overrides.media === null ? null : { ...READY_MEDIA, ...overrides.media };
  const job = overrides.job ?? null;

  const prisma = {
    project: { findFirst: vi.fn(async () => project) },
    mediaAsset: { findFirst: vi.fn(async () => media) },
    job: { findFirst: vi.fn(async () => job) },
  } as unknown as PrismaService;

  const repository = {
    latest: vi.fn(async () => overrides.transcript ?? null),
  } as unknown as TranscriptsRepository;

  const service = new TranscriptsService(
    prisma,
    repository,
    undefined as never,
    undefined as never,
    undefined as never,
  );

  return { service, prisma, repository };
}

const state = async (overrides: Overrides = {}) =>
  harness(overrides).service.transcriptionState("01PROJECT", "01WORKSPACE");

describe("TranscriptsService.transcriptionState", () => {
  // The whole point of the read model: a transcript row is the editor's green
  // light, and it outranks any job row still lying around.
  it("is ready as soon as a transcript row exists", async () => {
    await expect(state({ transcript: { id: "01TRANSCRIPT" } })).resolves.toEqual({
      status: "ready",
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

  it("reports queued, with the job id, while the job waits", async () => {
    const h = harness({ job: { id: "01JOB", status: "queued" } });
    await expect(h.service.transcriptionState("01PROJECT", "01WORKSPACE")).resolves.toEqual({
      status: "queued",
      jobId: "01JOB",
    });
    // Scoped to this project's transcription jobs — a render or export job of the
    // same project must never be read as the transcript's progress.
    expect(h.prisma.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "01PROJECT", type: "ai.transcribe" } }),
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
});
