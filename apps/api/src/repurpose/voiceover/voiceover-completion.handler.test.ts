import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RepurposeVoiceoverCompletionHandler } from "./voiceover-completion.handler.js";

import type { RepurposeVoiceoversService } from "./voiceovers.service.js";
import type {
  JobCompletionContext,
  JobCompletionRegistry,
} from "../../jobs/completion-handlers.js";

const FIXTURES = join(process.cwd(), "..", "..", "packages", "repurpose-contracts", "fixtures");
function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}
const PAYLOAD = fixture("ai-voiceover-payload.v1.json");
const RESULT = fixture("ai-voiceover-result.v1.json");
const JOB = "01JCJ0B0000000000000000001";

function handler() {
  const voiceovers = {
    applySpoken: vi.fn(async () => 20),
    applyJobFailed: vi.fn(async () => undefined),
  };
  const subject = new RepurposeVoiceoverCompletionHandler(
    voiceovers as unknown as RepurposeVoiceoversService,
    { register: vi.fn() } as unknown as JobCompletionRegistry,
  );
  return { subject, voiceovers };
}

function context(result: unknown, params: unknown = PAYLOAD): JobCompletionContext {
  return {
    job: { id: JOB, params, checkpoint: null },
    result,
    completion: { status: "succeeded" },
  } as unknown as JobCompletionContext;
}

describe("RepurposeVoiceoverCompletionHandler (2026-10-01)", () => {
  it("records the voice-over and settles at its price", async () => {
    const { subject, voiceovers } = handler();
    const outcome = await subject.handle(context(RESULT));
    expect(voiceovers.applySpoken).toHaveBeenCalledWith(PAYLOAD["voiceoverId"], JOB, {
      key: RESULT["key"],
      durationMs: 3000,
    });
    expect(outcome.actualTenths).toBe(20);
  });

  it("applies nothing, and fails the voice-over, for another voice-over's file", async () => {
    const { subject, voiceovers } = handler();
    const outcome = await subject.handle(
      context({ ...RESULT, voiceoverId: "01JCDVC0000000000000000099" }),
    );
    expect(outcome.actualTenths).toBe(0);
    expect(voiceovers.applySpoken).not.toHaveBeenCalled();
    expect(voiceovers.applyJobFailed).toHaveBeenCalledWith(
      PAYLOAD["voiceoverId"],
      JOB,
      expect.objectContaining({ code: "voiceover/result_mismatch" }),
    );
  });

  it("throws on a result that is not ai.voiceover@1 (the job system fails the job)", async () => {
    const { subject } = handler();
    await expect(subject.handle(context({ ...RESULT, extra: 1 }))).rejects.toThrow(
      /invalid result/u,
    );
  });

  it("passes a failure's code through", async () => {
    const { subject, voiceovers } = handler();
    await subject.handleFailure({
      job: { id: JOB, params: PAYLOAD },
      completion: { status: "failed", error: { code: "voiceover/vendor_refused", message: "no" } },
    } as unknown as JobCompletionContext);
    expect(voiceovers.applyJobFailed).toHaveBeenCalledWith(PAYLOAD["voiceoverId"], JOB, {
      code: "voiceover/vendor_refused",
      message: "no",
    });
  });
});
