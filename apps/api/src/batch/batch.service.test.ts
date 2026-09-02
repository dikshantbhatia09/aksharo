import { beforeEach, describe, expect, it, vi } from "vitest";

import { BatchService } from "./batch.service.js";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const USER = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const BATCH_ID = "01JBZ0Q4T7R8N4H1V0J9K2M3PE";
const PROJECT_A = "01JBZ0Q4T7R8N4H1V0J9K2M3PF";
const PROJECT_B = "01JBZ0Q4T7R8N4H1V0J9K2M3PG";

function makeService() {
  const prisma = {
    batch: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        workspaceId: WORKSPACE,
        createdBy: USER,
        settings: {},
        creditsQuotedTenths: 0,
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        ...args.data,
        id: BATCH_ID,
      })),
      findFirst: vi.fn(async () => ({
        id: BATCH_ID,
        workspaceId: WORKSPACE,
        createdBy: USER,
        settings: { languages: ["hi"] },
        creditsQuotedTenths: 240,
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
      })),
      findFirstOrThrow: vi.fn(async () => ({
        id: BATCH_ID,
        workspaceId: WORKSPACE,
        createdBy: USER,
        settings: { languages: ["hi"] },
        creditsQuotedTenths: 240,
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
      })),
    },
    project: {
      updateMany: vi.fn(async () => ({ count: 2 })),
      findMany: vi.fn(async () => [
        { id: PROJECT_A, title: "Clip A", status: "draft", jobs: [] },
        { id: PROJECT_B, title: "Clip B", status: "draft", jobs: [] },
      ]),
    },
  };

  const projects = {
    batchCreate: vi.fn(async () => [
      { id: PROJECT_A, title: "Clip A", status: "draft" },
      { id: PROJECT_B, title: "Clip B", status: "draft" },
    ]),
  };

  const transcripts = { transcribe: vi.fn(async () => ({ jobId: "job1" })) };
  const audit = { record: vi.fn(async () => undefined) };

  const service = new BatchService(
    prisma as never,
    projects as never,
    transcripts as never,
    audit as never,
  );
  return { service, prisma, projects, transcripts, audit };
}

describe("BatchService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("quotes each item and sums the total (1 credit/min transcription rate)", () => {
    const { service } = makeService();
    const quote = service.quote([60_000, 120_000]);
    expect(quote.perItemTenths).toEqual([10, 20]);
    expect(quote.totalTenths).toBe(30);
    expect(quote.totalCredits).toBe("3");
  });

  it("creates N projects, tags them with the batch id, and stores the quote", async () => {
    const { service, prisma, projects } = makeService();

    const view = await service.create(WORKSPACE, USER, {
      projects: [{ title: "Clip A" }, { title: "Clip B" }],
      durationsMs: [60_000, 60_000],
    });

    expect(projects.batchCreate).toHaveBeenCalled();
    expect(prisma.project.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [PROJECT_A, PROJECT_B] } },
      data: { batchId: BATCH_ID },
    });
    expect(view.projects).toHaveLength(2);
  });

  it("apply() enqueues transcription for every project in the batch, per-project failures don't fail the batch", async () => {
    const { service, transcripts } = makeService();
    transcripts.transcribe = vi
      .fn()
      .mockResolvedValueOnce({ jobId: "job1" })
      .mockRejectedValueOnce(new Error("transcript/media_not_ready"));

    const view = await service.apply(WORKSPACE, USER, BATCH_ID, {});

    expect(transcripts.transcribe).toHaveBeenCalledTimes(2);
    expect(view.id).toBe(BATCH_ID);
  });

  it("apply() overrides stored settings with the ones passed to it", async () => {
    const { service, transcripts } = makeService();

    await service.apply(WORKSPACE, USER, BATCH_ID, { settings: { languages: ["ta"] } });

    expect(transcripts.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ languages: ["ta"] }),
    );
  });
});
