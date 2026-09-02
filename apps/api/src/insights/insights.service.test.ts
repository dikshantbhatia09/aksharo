import { HttpStatus } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { INSIGHTS_DISCLOSURE, InsightsService } from "./insights.service.js";
import { AppException } from "../common/errors/error-codes.js";

import type { InsightsRepository } from "./insights.repository.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { EdgRepository } from "../edg/index.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { TranscriptsService } from "../transcripts/transcripts.service.js";

const PROJECT_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VC";
const WORKSPACE_ID = "01JBQ8Z2W4N7Y0K3M5P8R1T6VB";

function buildService(overrides?: {
  region?: string;
  chunksResult?: unknown;
  edgDocumentId?: string;
  edgProjection?: unknown;
  edgChunks?: unknown;
}): {
  service: InsightsService;
  jobs: { enqueue: ReturnType<typeof vi.fn> };
  transcripts: { chunks: ReturnType<typeof vi.fn> };
  repository: { latestPerKind: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  edgRepository: { projectionOf: ReturnType<typeof vi.fn>; loadChunks: ReturnType<typeof vi.fn> };
} {
  const prisma = {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: PROJECT_ID,
        title: "My Video",
        ...(overrides?.edgDocumentId === undefined
          ? {}
          : { edgDocument: { id: overrides.edgDocumentId } }),
      }),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ region: overrides?.region ?? "in" }),
    },
  } as unknown as PrismaService;

  const jobs = {
    enqueue: vi.fn().mockResolvedValue({ job: { id: "job1" }, deduplicated: false }),
  };

  const chunksResult = overrides?.chunksResult ?? {
    transcript: { language: "en", durationMs: 8_000 },
    chunks: [
      {
        chunkIdx: 0,
        startMs: 0,
        endMs: 8_000,
        words: [
          { wid: "0:0", s: 0, e: 500, t: "Hello", sp: "spk0" },
          { wid: "0:1", s: 500, e: 1_000, t: "world" },
        ],
      },
    ],
    nextCursor: null,
  };
  const transcripts = { chunks: vi.fn().mockResolvedValue(chunksResult) };

  const repository = {
    latestPerKind: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  };

  const edgRepository = {
    projectionOf: vi.fn().mockResolvedValue(overrides?.edgProjection),
    loadChunks: vi.fn().mockResolvedValue(overrides?.edgChunks ?? []),
  };

  const service = new InsightsService(
    prisma,
    jobs as unknown as JobsService,
    transcripts as unknown as TranscriptsService,
    repository as unknown as InsightsRepository,
    edgRepository as unknown as EdgRepository,
  );
  return { service, jobs, transcripts, repository, edgRepository };
}

describe("InsightsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quotes and enqueues one ai.llm job per requested kind", async () => {
    const { service, jobs } = buildService();
    const result = await service.request({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      kinds: ["chapters", "summary"],
    });

    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(result.jobs.map((j) => j.kind)).toEqual(["chapters", "summary"]);
    expect(result.totalTenths).toBe(20 + 10); // chapters 2cr, summary 1cr
  });

  it("builds the job payload from transcript text only (PII minimisation, brief §2)", async () => {
    const { service, jobs } = buildService();
    await service.request({ projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, kinds: ["hooks"] });

    const call = jobs.enqueue.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect(call.params.kind).toBe("hooks");
    expect(call.params.region).toBe("in");
    const transcript = call.params.transcript as { segments: unknown[]; mediaTitle: string };
    expect(transcript.mediaTitle).toBe("My Video");
    expect(transcript.segments).toHaveLength(1);
    // Never a user id, email or name in the payload.
    expect(JSON.stringify(call.params)).not.toContain(WORKSPACE_ID);
  });

  it("pins the job to the workspace's region", async () => {
    const { service, jobs } = buildService({ region: "eu" });
    await service.request({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      kinds: ["chapters"],
    });
    const call = jobs.enqueue.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect(call.params.region).toBe("eu");
  });

  it("passes tone through for regeneration", async () => {
    const { service, jobs } = buildService();
    await service.request({
      projectId: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      kinds: ["hooks"],
      tone: "bold",
      regenerate: true,
    });
    const call = jobs.enqueue.mock.calls[0]?.[0] as { params: Record<string, unknown> };
    expect(call.params.tone).toBe("bold");
  });

  it("404s for a project in another workspace rather than 403ing (THREAT-MODEL T4/T5)", async () => {
    const { service } = buildService();
    (service as unknown as { prisma: { project: { findFirst: ReturnType<typeof vi.fn> } } })[
      "prisma"
    ].project.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.request({ projectId: "nope", workspaceId: WORKSPACE_ID, kinds: ["chapters"] }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
  });

  it("throws AppException, not a generic error, on a missing project", async () => {
    const { service } = buildService();
    (service as unknown as { prisma: { project: { findFirst: ReturnType<typeof vi.fn> } } })[
      "prisma"
    ].project.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.request({ projectId: "nope", workspaceId: WORKSPACE_ID, kinds: ["chapters"] }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it("lists the most recent row per kind", async () => {
    const { service, repository } = buildService();
    repository.latestPerKind.mockResolvedValueOnce([{ id: "row1", kind: "chapters" }]);
    const rows = await service.list(PROJECT_ID, WORKSPACE_ID);
    expect(rows).toHaveLength(1);
  });

  it("exposes the ASCI-friendly disclosure line verbatim (brief §5)", () => {
    expect(INSIGHTS_DISCLOSURE).toBe("Generated by AI from your transcript");
  });

  describe("EDG transcript payload (B11b ruling 3)", () => {
    const edgProjection = {
      transcript: { transcriptId: "01TRANSCRIPT000000000000000", language: "hi-Latn" },
      segments: [
        { id: "seg1", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 1_000 },
        { id: "seg2", startWordId: "0:2", endWordId: "0:2", startMs: 1_000, endMs: 1_500 },
      ],
    };
    const edgChunks = [
      {
        chunkIdx: 0,
        startMs: 0,
        endMs: 1_500,
        words: [
          { wid: "0:0", s: 0, e: 400, t: "namaste", sp: "spk0" },
          { wid: "0:1", s: 400, e: 900, t: "duniya" },
          { wid: "0:2", s: 900, e: 1_500, t: "deleted-word", deleted: true },
        ],
      },
    ];

    it("builds segments from the EDG document when the project has one", async () => {
      const { service, jobs, edgRepository } = buildService({
        edgDocumentId: "01EDGDOC0000000000000000000",
        edgProjection,
        edgChunks,
      });

      await service.request({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        kinds: ["chapters"],
      });

      expect(edgRepository.projectionOf).toHaveBeenCalledWith("01EDGDOC0000000000000000000");
      expect(edgRepository.loadChunks).toHaveBeenCalledWith(edgProjection.transcript.transcriptId);

      const call = jobs.enqueue.mock.calls[0]?.[0] as { params: Record<string, unknown> };
      const transcript = call.params.transcript as {
        language: string;
        segments: { text: string; speaker?: string }[];
      };
      expect(transcript.language).toBe("hi-Latn");
      // seg1 resolves "namaste duniya"; seg2's only word is deleted, so it drops out.
      expect(transcript.segments).toEqual([
        expect.objectContaining({ text: "namaste duniya", speaker: "spk0" }),
      ]);
    });

    it("falls back to the chunk path when the EDG document has no live segments", async () => {
      const { service, jobs, edgRepository, transcripts } = buildService({
        edgDocumentId: "01EDGDOC0000000000000000000",
        edgProjection: { ...edgProjection, segments: [] },
        edgChunks,
      });

      await service.request({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        kinds: ["chapters"],
      });

      expect(edgRepository.projectionOf).toHaveBeenCalled();
      expect(transcripts.chunks).toHaveBeenCalled();
      const call = jobs.enqueue.mock.calls[0]?.[0] as { params: Record<string, unknown> };
      const transcript = call.params.transcript as { segments: unknown[] };
      expect(transcript.segments).toHaveLength(1);
    });

    it("never calls the EDG repository for a project with no EDG document", async () => {
      const { service, edgRepository } = buildService();
      await service.request({
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        kinds: ["chapters"],
      });
      expect(edgRepository.projectionOf).not.toHaveBeenCalled();
    });
  });
});
