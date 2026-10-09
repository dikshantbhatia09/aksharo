import { HttpStatus, RequestMethod } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { CLIP_RATE_LIMITS } from "./repurpose-clips.dto.js";
import { ClipTrimController } from "./clip-trim.controller.js";
import { RepurposeSteeringController } from "./repurpose-steering.controller.js";
import {
  adjustCandidateSchema,
  clipLayoutSchema,
  trimClipSchema,
} from "./repurpose-steering.dto.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../common/guards/index.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const CAND = "01JCCANDA00000000000000000";
const CLIP = "01JCC11PA00000000000000000";

// Nest's own metadata keys (`@nestjs/common/constants`), read the way the router does.
function route(name: keyof RepurposeSteeringController) {
  const handler = Object.getOwnPropertyDescriptor(RepurposeSteeringController.prototype, name)
    ?.value as object;
  return {
    path: Reflect.getMetadata("path", handler) as string,
    method: Reflect.getMetadata("method", handler) as RequestMethod,
    httpCode: Reflect.getMetadata("__httpCode__", handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
  };
}

describe("RepurposeSteeringController", () => {
  it("serves remove, restore and adjust from the steering service", async () => {
    const steering = {
      removeCandidate: vi.fn(async () => ({ candidate: { id: CAND }, clip: null, promoted: [] })),
      restoreCandidate: vi.fn(async () => ({ candidate: { id: CAND }, clip: null, promoted: [] })),
      adjustCandidate: vi.fn(async () => ({ candidate: { id: CAND }, clip: null, promoted: [] })),
    };
    const controller = new RepurposeSteeringController(steering as never);

    await controller.remove(WS, USER, RUN, CAND);
    expect(steering.removeCandidate).toHaveBeenCalledWith(WS, USER, RUN, CAND);
    await controller.restore(WS, USER, RUN, CAND);
    expect(steering.restoreCandidate).toHaveBeenCalledWith(WS, USER, RUN, CAND);
    await controller.adjust(WS, USER, RUN, CAND, { startMs: 1_000, endMs: 9_000 });
    expect(steering.adjustCandidate).toHaveBeenCalledWith(WS, USER, RUN, CAND, {
      startMs: 1_000,
      endMs: 9_000,
    });
  });

  it("mounts each route on the moment, for editors, rate-limited like a cut", () => {
    expect(route("adjust")).toMatchObject({
      path: ":runId/candidates/:candidateId",
      method: RequestMethod.PATCH,
      roles: ["editor"],
    });
    expect(route("remove")).toMatchObject({
      path: ":runId/candidates/:candidateId/remove",
      method: RequestMethod.POST,
      roles: ["editor"],
      httpCode: HttpStatus.OK,
    });
    expect(route("restore")).toMatchObject({
      path: ":runId/candidates/:candidateId/restore",
      method: RequestMethod.POST,
      roles: ["editor"],
      httpCode: HttpStatus.OK,
    });
    for (const name of ["adjust", "remove", "restore"] as const) {
      expect(route(name).rateLimits, name).toEqual([CLIP_RATE_LIMITS.mutate]);
    }
  });

  it("sets a clip's layout on the clip, for editors, rate-limited like a cut (2026-10-01)", async () => {
    const steering = {
      setClipLayout: vi.fn(async () => ({
        clipId: CLIP,
        layout: "stacked",
        applied: "stacked",
        recut: true,
        clip: null,
      })),
    };
    const controller = new RepurposeSteeringController(steering as never);
    await controller.setLayout(WS, USER, RUN, CLIP, { layout: "stacked" });
    expect(steering.setClipLayout).toHaveBeenCalledWith(WS, USER, RUN, CLIP, {
      layout: "stacked",
    });
    expect(route("setLayout")).toMatchObject({
      path: ":runId/clips/:clipId/layout",
      method: RequestMethod.PUT,
      roles: ["editor"],
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });
    for (const layout of ["auto", "single", "stacked"]) {
      expect(clipLayoutSchema.safeParse({ layout }).success).toBe(true);
    }
    for (const body of [{ layout: "both" }, { layout: "" }, {}]) {
      expect(clipLayoutSchema.safeParse(body).success).toBe(false);
    }
  });

  it("leaves a moment's range to the service, which answers with clip_bounds_invalid", () => {
    expect(adjustCandidateSchema.safeParse({ startMs: -5, endMs: 1 }).success).toBe(true);
    expect(adjustCandidateSchema.safeParse({ startMs: 1000, endMs: 5000, bypassSnap: true }).success).toBe(true);
    expect(adjustCandidateSchema.safeParse({ startMs: "0", endMs: 1 }).success).toBe(false);
    expect(adjustCandidateSchema.safeParse({ startMs: 0 }).success).toBe(false);
    expect(adjustCandidateSchema.safeParse({ startMs: Infinity, endMs: 1 }).success).toBe(false);
  });

  it("mounts PATCH :runId/clips/:clipId/trim and delegates to steering.trimClip", async () => {
    const steering = {
      trimClip: vi.fn(async () => ({
        clipId: CLIP,
        runId: RUN,
        candidateId: CAND,
        startSec: 12.4,
        endSec: 45.8,
        startMs: 12_400,
        endMs: 45_800,
        durationMs: 33_400,
        isManualOverride: true,
        manualStartSec: 12.4,
        manualEndSec: 45.8,
        snappedStart: true,
        snappedEnd: true,
        words: [],
        lines: [],
        clip: null,
        candidate: null,
      })),
    };
    const controller = new RepurposeSteeringController(steering as never);
    await controller.trim(WS, USER, RUN, CLIP, { startSec: 12.4, endSec: 45.8 });
    expect(steering.trimClip).toHaveBeenCalledWith(WS, USER, RUN, CLIP, {
      startSec: 12.4,
      endSec: 45.8,
    });
    expect(route("trim")).toMatchObject({
      path: ":runId/clips/:clipId/trim",
      method: RequestMethod.PATCH,
      roles: ["editor"],
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });
  });

  it("mounts PATCH /api/v1/projects/:id/clips/:clipId/trim on ClipTrimController", async () => {
    const steering = {
      trimClip: vi.fn(async () => ({ clipId: CLIP })),
    };
    const clipTrim = new ClipTrimController(steering as never);
    await clipTrim.trimV1(WS, USER, RUN, CLIP, {
      startSec: 10,
      endSec: 25,
      bypassSnap: true,
    });
    expect(steering.trimClip).toHaveBeenCalledWith(WS, USER, RUN, CLIP, {
      startSec: 10,
      endSec: 25,
      bypassSnap: true,
    });
    await clipTrim.updateClipBoundsV1(WS, USER, RUN, CLIP, {
      startSec: 12,
      endSec: 28,
    });
    await clipTrim.trimProjectClip(WS, USER, RUN, CLIP, {
      startSec: 14,
      endSec: 30,
    });
    expect(steering.trimClip).toHaveBeenCalledTimes(3);

    expect(
      trimClipSchema.safeParse({ startSec: 12.4, endSec: 45.8, isManualOverride: true }).success,
    ).toBe(true);
    expect(
      trimClipSchema.safeParse({ manualStartSec: 12.4, manualEndSec: 45.8, bypassSnap: true })
        .success,
    ).toBe(true);
    expect(trimClipSchema.safeParse({ startMs: 12400, endMs: 45800 }).success).toBe(true);
    expect(trimClipSchema.safeParse({}).success).toBe(false);
  });
});

