import { describe, expect, it } from "vitest";

import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";
import { TransliterateCompletionHandler } from "./transliterate.handler.js";

import type { JobCompletionContext } from "../../jobs/completion-handlers.js";
import type { Job } from "@prisma/client";

const JOB_ID = "01JCJOB000000000000000000A";
const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPROJECT000000000000000";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    workspaceId: WS,
    projectId: PROJECT,
    type: "ai.transliterate",
    status: "running",
    priority: 5,
    creditsChargedTenths: 0,
    creditHoldId: "hold-1",
    ...overrides,
  } as Job;
}

function context(result: Record<string, unknown> = {}): JobCompletionContext {
  return {
    job: job(),
    attemptId: "01JCATTEMPT0000000000000A",
    result: {
      transcriptId: "01JCTRANSCRIPT0000000000000",
      targetScript: "native",
      wordsUpdated: 5,
      wordsPreserved: 1,
      provider: "indicxlit-ruletable",
      applied: true,
      ...result,
    },
    usage: undefined,
    completion: { status: "succeeded" },
  };
}

describe("TransliterateCompletionHandler", () => {
  it("owns ai.transliterate and registers itself at boot", () => {
    const registry = new JobCompletionRegistry();
    const handler = new TransliterateCompletionHandler(registry);
    expect(handler.jobType).toBe("ai.transliterate");
    handler.onModuleInit();
    expect(registry.handlerFor("ai.transliterate")).toBe(handler);
  });

  it("settles zero tenths — transliteration is free", async () => {
    const handler = new TransliterateCompletionHandler(new JobCompletionRegistry());
    const outcome = await handler.handle(context());
    expect(outcome.actualTenths).toBe(0);
  });

  it("mirrors the worker's summary into the completion data, doing no writes of its own", async () => {
    const handler = new TransliterateCompletionHandler(new JobCompletionRegistry());
    const outcome = await handler.handle(context());
    expect(outcome.data).toMatchObject({
      targetScript: "native",
      wordsUpdated: 5,
      wordsPreserved: 1,
      provider: "indicxlit-ruletable",
    });
  });

  it("tolerates a result missing every optional field", async () => {
    const handler = new TransliterateCompletionHandler(new JobCompletionRegistry());
    await expect(
      handler.handle({
        job: job(),
        attemptId: "a",
        result: {},
        usage: undefined,
        completion: { status: "succeeded" },
      }),
    ).resolves.toMatchObject({ actualTenths: 0 });
  });
});
