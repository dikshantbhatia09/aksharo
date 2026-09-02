import { beforeEach, describe, expect, it, vi } from "vitest";

import { TranslateCompletionHandler } from "./translate.handler.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type { ScriptsService } from "./scripts.service.js";
import type { JobCompletionContext } from "../../jobs/completion-handlers.js";
import type { JobEventsService } from "../../jobs/job-events.service.js";
import type { Job } from "@prisma/client";

const JOB_ID = "01JCJOB000000000000000000A";
const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPROJECT000000000000000";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    workspaceId: WS,
    projectId: PROJECT,
    type: "ai.translate",
    status: "running",
    priority: 5,
    creditsChargedTenths: 25,
    creditHoldId: "hold-1",
    ...overrides,
  } as Job;
}

function context(
  result: Record<string, unknown> = {},
  jobOverrides: Partial<Job> = {},
): JobCompletionContext {
  return {
    job: job(jobOverrides),
    attemptId: "01JCATTEMPT0000000000000A",
    result: {
      targetLanguage: "en",
      segmentsTranslated: 3,
      provider: "sarvam-mayura",
      lengthRetries: 1,
      truncated: 0,
      applied: true,
      ...result,
    },
    usage: undefined,
    completion: { status: "succeeded" },
  };
}

interface Harness {
  handler: TranslateCompletionHandler;
  recordTranslationLanguage: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  registry: JobCompletionRegistry;
}

function harness(): Harness {
  const recordTranslationLanguage = vi.fn(async () => undefined);
  const append = vi.fn(async () => undefined);
  const registry = new JobCompletionRegistry();
  const handler = new TranslateCompletionHandler(
    { recordTranslationLanguage } as unknown as ScriptsService,
    { append } as unknown as JobEventsService,
    registry,
  );
  return { handler, recordTranslationLanguage, append, registry };
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("TranslateCompletionHandler", () => {
  it("owns ai.translate and registers itself at boot", () => {
    expect(h.handler.jobType).toBe("ai.translate");
    h.handler.onModuleInit();
    expect(h.registry.handlerFor("ai.translate")).toBe(h.handler);
  });

  it("records the target language on the EDG document meta", async () => {
    await h.handler.handle(context());
    expect(h.recordTranslationLanguage).toHaveBeenCalledWith(PROJECT, "en");
  });

  it("logs transcript.translated with the worker's summary", async () => {
    await h.handler.handle(context());
    expect(h.append).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        name: "transcript.translated",
        data: expect.objectContaining({
          script: "translated",
          targetLanguage: "en",
          provider: "sarvam-mayura",
          segmentsTranslated: 3,
        }),
      }),
    );
  });

  it("does not settle a different amount — the hold already equals the actual", async () => {
    const outcome = await h.handler.handle(context());
    expect(outcome.actualTenths).toBeUndefined();
  });

  it("skips the meta write and the event when the job has no project", async () => {
    await h.handler.handle(context({}, { projectId: null }));
    expect(h.recordTranslationLanguage).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it("skips both when the worker reported no targetLanguage", async () => {
    await h.handler.handle(context({ targetLanguage: undefined }));
    expect(h.recordTranslationLanguage).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });
});
