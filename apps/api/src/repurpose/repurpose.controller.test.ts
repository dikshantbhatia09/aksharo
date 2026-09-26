import { HttpStatus, RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { addCandidateSchema, CLIP_RATE_LIMITS, createClipSchema } from "./repurpose-clips.dto.js";
import { RepurposeController } from "./repurpose.controller.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../common/guards/index.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const CLIP = "01JCC11P000000000000000000";
const CAND = "01JCCANDA00000000000000000";

// Nest's own metadata keys (`@nestjs/common/constants`), read the way the router does.
const PATH = "path";
const METHOD = "method";
const HTTP_CODE = "__httpCode__";

function route(name: keyof RepurposeController) {
  const handler = Object.getOwnPropertyDescriptor(RepurposeController.prototype, name)
    ?.value as object;
  return {
    path: Reflect.getMetadata(PATH, handler) as string,
    method: Reflect.getMetadata(METHOD, handler) as RequestMethod,
    httpCode: Reflect.getMetadata(HTTP_CODE, handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
  };
}

function harness() {
  const clips = {
    listClips: vi.fn(async () => ({ runId: RUN, clips: [] })),
    createClip: vi.fn(async () => ({ id: CLIP, state: "cutting" })),
    retryClip: vi.fn(async () => ({ id: CLIP, state: "cutting" })),
    addManualCandidate: vi.fn(async () => ({ id: CAND, source: "manual" })),
  };
  const controller = new RepurposeController({} as never, clips as never, {} as never);
  return { controller, clips };
}

describe("RepurposeController — clips and moments", () => {
  it("serves the clip routes from the clips service", async () => {
    const { controller, clips } = harness();

    await controller.listClips(WS, RUN);
    expect(clips.listClips).toHaveBeenCalledWith(WS, RUN);

    await controller.createClip(WS, USER, RUN, { candidateId: CAND });
    expect(clips.createClip).toHaveBeenCalledWith(WS, USER, RUN, { candidateId: CAND });

    await controller.retryClip(WS, USER, RUN, CLIP);
    expect(clips.retryClip).toHaveBeenCalledWith(WS, USER, RUN, CLIP);

    await controller.addCandidate(WS, USER, RUN, { startMs: 0, endMs: 5_000 });
    expect(clips.addManualCandidate).toHaveBeenCalledWith(WS, USER, RUN, {
      startMs: 0,
      endMs: 5_000,
    });
  });

  it("mounts each route where the page calls it, with the right role", () => {
    expect(route("listClips")).toMatchObject({
      path: ":runId/clips",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route("createClip")).toMatchObject({
      path: ":runId/clips",
      method: RequestMethod.POST,
      roles: ["editor"],
    });
    expect(route("retryClip")).toMatchObject({
      path: ":runId/clips/:clipId/retry",
      method: RequestMethod.POST,
      roles: ["editor"],
    });
    expect(route("addCandidate")).toMatchObject({
      path: ":runId/candidates",
      method: RequestMethod.POST,
      roles: ["editor"],
    });
  });

  it("answers a retry with 200 and a new clip or moment with the POST default, 201", () => {
    expect(route("retryClip").httpCode).toBe(HttpStatus.OK);
    expect(route("createClip").httpCode).toBeUndefined();
    expect(route("addCandidate").httpCode).toBeUndefined();
  });

  it("rate-limits every route that can start a cut or add a moment", () => {
    for (const name of ["createClip", "retryClip", "addCandidate"] as const) {
      expect(route(name).rateLimits).toEqual([CLIP_RATE_LIMITS.mutate]);
    }
  });
});

describe("clip request bodies", () => {
  it("require a moment id that is a ULID, and drop the page's old aspect field", () => {
    expect(createClipSchema.safeParse({}).success).toBe(false);
    expect(createClipSchema.safeParse({ candidateId: "not-a-ulid" }).success).toBe(false);
    expect(createClipSchema.parse({ candidateId: CAND, aspect: "9:16" })).toEqual({
      candidateId: CAND,
    });
  });

  it("leave a moment's range to the service, which answers with clip_bounds_invalid", () => {
    // A Zod range would answer `common/validation_failed`, a code the page has
    // no sentence for.
    expect(addCandidateSchema.safeParse({ startMs: -5, endMs: 1 }).success).toBe(true);
    expect(addCandidateSchema.safeParse({ startMs: "0", endMs: 1 }).success).toBe(false);
    expect(addCandidateSchema.safeParse({ startMs: 0, endMs: 5_000, title: " " }).success).toBe(
      false,
    );
  });
});
