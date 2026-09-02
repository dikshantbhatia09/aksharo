import { describe, expect, it, vi } from "vitest";

import { InsightsCompletionHandler } from "./insights.completion.handler.js";

import type { InsightsRepository } from "./insights.repository.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionRegistry } from "../jobs/completion-handlers.js";
import type { Job } from "@prisma/client";

function buildHandler(): {
  handler: InsightsCompletionHandler;
  prisma: { providerSubmission: { createMany: ReturnType<typeof vi.fn> } };
  repository: { create: ReturnType<typeof vi.fn> };
} {
  const prisma = {
    providerSubmission: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const repository = {
    create: vi.fn().mockResolvedValue({ id: "output1" }),
  };
  const registry = { register: vi.fn() } as unknown as JobCompletionRegistry;
  const handler = new InsightsCompletionHandler(
    prisma as unknown as PrismaService,
    repository as unknown as InsightsRepository,
    registry,
  );
  return { handler, prisma, repository };
}

const JOB = {
  id: "job1",
  workspaceId: "ws1",
  projectId: "proj1",
  creditsChargedTenths: 20,
} as unknown as Job;

describe("InsightsCompletionHandler", () => {
  it("registers itself for the ai.llm queue", () => {
    const { handler } = buildHandler();
    expect(handler.jobType).toBe("ai.llm");
  });

  it("persists the worker's {templateId, version, provider, region, output, usage} as one llm_outputs row", async () => {
    const { handler, repository } = buildHandler();
    const outcome = await handler.handle({
      job: JOB,
      attemptId: "attempt1",
      usage: undefined,
      completion: {} as never,
      result: {
        templateId: "chapters",
        version: "chapters@1",
        provider: "mock",
        region: "in",
        output: { chapters: [{ startMs: 0, title: "Intro" }] },
        usage: { inputTokens: 10, outputTokens: 20 },
        providerSubmissions: [],
      },
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj1",
        kind: "chapters",
        provider: "mock",
        region: "in",
      }),
    );
    expect(outcome.actualTenths).toBe(20); // chapters = 2 credits = 20 tenths
    expect(outcome.data).toMatchObject({ id: "output1", kind: "chapters" });
  });

  it("records every provider_submissions row the worker reported (erasure trail)", async () => {
    const { handler, prisma } = buildHandler();
    await handler.handle({
      job: JOB,
      attemptId: "attempt1",
      usage: undefined,
      completion: {} as never,
      result: {
        templateId: "summary",
        version: "summary@1",
        provider: "anthropic",
        region: "eu",
        output: { short: "s", medium: "m", long: "l" },
        usage: {},
        providerSubmissions: [
          { provider: "anthropic", region: "eu", retentionClass: "zero_retention" },
        ],
      },
    });
    expect(prisma.providerSubmission.createMany).toHaveBeenCalledTimes(1);
    const data = prisma.providerSubmission.createMany.mock.calls[0]?.[0] as {
      data: { retentionClass: string }[];
    };
    expect(data.data[0]?.retentionClass).toBe("zero_retention");
  });

  it("never settles more than the hold, even if the price table disagrees", async () => {
    const { handler } = buildHandler();
    const outcome = await handler.handle({
      job: { ...JOB, creditsChargedTenths: 5 }, // held less than chapters' 20 tenths
      attemptId: "attempt1",
      usage: undefined,
      completion: {} as never,
      result: {
        templateId: "chapters",
        version: "chapters@1",
        provider: "mock",
        region: "in",
        output: { chapters: [{ startMs: 0, title: "Intro" }] },
        usage: {},
        providerSubmissions: [],
      },
    });
    expect(outcome.actualTenths).toBe(5);
  });

  it("rejects a completion with no project", async () => {
    const { handler } = buildHandler();
    await expect(
      handler.handle({
        job: { ...JOB, projectId: null },
        attemptId: "attempt1",
        usage: undefined,
        completion: {} as never,
        result: {
          templateId: "chapters",
          version: "chapters@1",
          provider: "mock",
          region: "in",
          output: { chapters: [] },
          usage: {},
          providerSubmissions: [],
        },
      }),
    ).rejects.toThrow(/no project/);
  });
});
