import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { RepurposeDubCompletionHandler } from "./dub-completion.handler.js";
import { JobCompletionRegistry } from "../../jobs/completion-handlers.js";

import type { RepurposeDubsService } from "./dubs.service.js";
import type { JobCompletionContext } from "../../jobs/completion-handlers.js";
import type { Job } from "@prisma/client";

const FIXTURES = resolve(process.cwd(), "..", "..", "packages", "repurpose-contracts", "fixtures");
function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a repository fixture
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const PAYLOAD = fixture("ai-dub-payload.v1.json");
const RESULT = fixture("ai-dub-result.v1.json");
const JOB_ID = "01JCJ0BDUB0000000000000000";

function harness() {
  const dubs = {
    applyDubbed: vi.fn(async () => 142),
    applyJobFailed: vi.fn(async () => undefined),
  };
  const registry = new JobCompletionRegistry();
  const handler = new RepurposeDubCompletionHandler(
    dubs as unknown as RepurposeDubsService,
    registry,
  );
  handler.onModuleInit();
  return { dubs, registry, handler };
}

function context(
  params: Record<string, unknown>,
  result: Record<string, unknown>,
  extra: Partial<JobCompletionContext> = {},
): JobCompletionContext {
  return {
    job: {
      id: JOB_ID,
      params,
      checkpoint: { vendorJobId: "job-1", vendorPhase: "started" },
    } as unknown as Job,
    attemptId: "a",
    result,
    usage: undefined,
    completion: { status: "succeeded", result },
    ...extra,
  };
}

describe("RepurposeDubCompletionHandler (2026-10-04)", () => {
  it("owns ai.dub completions", () => {
    expect(harness().registry.handlerFor("ai.dub")).toBeInstanceOf(RepurposeDubCompletionHandler);
  });

  it("files the vendor's files on the dub and settles on what the dub says came back", async () => {
    const { handler, dubs } = harness();
    const outcome = await handler.handle(context(PAYLOAD, RESULT));
    expect(dubs.applyDubbed).toHaveBeenCalledWith(PAYLOAD["dubId"], JOB_ID, {
      vendorJobId: RESULT["vendorJobId"],
      tracks: expect.arrayContaining([expect.objectContaining({ language: "hi-IN" })]) as unknown,
    });
    expect(outcome.actualTenths).toBe(142);
  });

  it("applies nothing a worker reports outside the dub's own folder, and charges nothing", async () => {
    const { handler, dubs } = harness();
    const tracks = (RESULT["tracks"] as Record<string, unknown>[]).map((track) => ({ ...track }));
    const first = tracks[0] as Record<string, unknown>;
    first["captions"] = {
      key:
        String(PAYLOAD["destinationPrefix"]).replace(
          /dubs\/[0-9A-Z]{26}$/,
          "dubs/01JCANTHERDVB0000000000000",
        ) + "/hi-IN/captions.srt",
      sizeBytes: 3,
    };
    const outcome = await handler.handle(context(PAYLOAD, { ...RESULT, tracks }));
    expect(outcome).toMatchObject({ actualTenths: 0, data: { applied: false } });
    expect(dubs.applyDubbed).not.toHaveBeenCalled();
    expect(dubs.applyJobFailed).toHaveBeenCalledWith(
      PAYLOAD["dubId"],
      JOB_ID,
      expect.objectContaining({ code: "dub/result_mismatch" }),
      expect.anything(),
    );
  });

  it("applies nothing for another dub's result", async () => {
    const { handler, dubs } = harness();
    const outcome = await handler.handle(
      context(PAYLOAD, { ...RESULT, dubId: "01JCANTHERDVB0000000000000" }),
    );
    expect(outcome.actualTenths).toBe(0);
    expect(dubs.applyDubbed).not.toHaveBeenCalled();
  });

  it("settles a cancel job at nothing and records nothing", async () => {
    const { handler, dubs } = harness();
    const outcome = await handler.handle(
      context(fixture("ai-dub-cancel-payload.v1.json"), fixture("ai-dub-cancel-result.v1.json")),
    );
    expect(outcome.actualTenths).toBe(0);
    expect(dubs.applyDubbed).not.toHaveBeenCalled();
  });

  it("refuses a result it cannot read, so the worker's retry delivers it again", async () => {
    const { handler } = harness();
    await expect(handler.handle(context(PAYLOAD, { schemaVersion: 1 }))).rejects.toThrow(
      /invalid result/,
    );
  });

  it("fails the dub with the worker's code, and the checkpoint that says what the vendor spent", async () => {
    const { handler, dubs } = harness();
    await handler.handleFailure(
      context(
        PAYLOAD,
        {},
        {
          completion: {
            status: "failed",
            error: { code: "dub/vendor_refused", message: "Audio has no speech", retryable: false },
          },
        },
      ),
    );
    expect(dubs.applyJobFailed).toHaveBeenCalledWith(
      PAYLOAD["dubId"],
      JOB_ID,
      { code: "dub/vendor_refused", message: "Audio has no speech" },
      { vendorJobId: "job-1", vendorPhase: "started" },
    );
    // A cancel job failing is nobody's dub.
    dubs.applyJobFailed.mockClear();
    await handler.handleFailure(context(fixture("ai-dub-cancel-payload.v1.json"), {}));
    expect(dubs.applyJobFailed).not.toHaveBeenCalled();
  });
});
