import { HttpStatus, RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { RepurposeCompilationsController } from "./compilations.controller.js";
import { createCompilationSchema, createSeriesSchema } from "./compilations.dto.js";
import { CLIP_RATE_LIMITS } from "./repurpose-clips.dto.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const ID = "01JCC0MP11AT10N00000000000";
const CLIP_A = "01JCC11PA00000000000000000";
const CLIP_B = "01JCC11PB00000000000000000";

function route(name: keyof RepurposeCompilationsController) {
  const handler = Object.getOwnPropertyDescriptor(RepurposeCompilationsController.prototype, name)
    ?.value as object;
  return {
    path: Reflect.getMetadata("path", handler) as string,
    method: Reflect.getMetadata("method", handler) as RequestMethod,
    httpCode: Reflect.getMetadata("__httpCode__", handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
  };
}

function controller() {
  const compilations = {
    list: vi.fn(async () => ({ runId: RUN, compilations: [] })),
    get: vi.fn(async () => ({ id: ID })),
    create: vi.fn(async () => ({ compilation: { id: ID }, created: true })),
    retry: vi.fn(async () => ({ id: ID })),
    remove: vi.fn(async () => undefined),
  };
  const series = {
    list: vi.fn(async () => ({ runId: RUN, series: [] })),
    create: vi.fn(async () => ({ id: ID })),
    remove: vi.fn(async () => ({ id: ID, restored: 2 })),
  };
  return {
    compilations,
    series,
    controller: new RepurposeCompilationsController(compilations as never, series as never),
  };
}

describe("RepurposeCompilationsController (2026-10-03)", () => {
  it("answers a new compilation 201 and one already made 200", async () => {
    const { controller: routes, compilations } = controller();
    const response = { status: vi.fn() };
    const body = { clipIds: [CLIP_A, CLIP_B], shape: "9:16" as const };
    await expect(routes.create(WS, USER, RUN, body, response as never)).resolves.toEqual({
      id: ID,
    });
    expect(compilations.create).toHaveBeenCalledWith(WS, USER, RUN, body);
    expect(response.status).toHaveBeenLastCalledWith(HttpStatus.CREATED);

    compilations.create.mockResolvedValueOnce({ compilation: { id: ID }, created: false });
    await routes.create(WS, USER, RUN, body, response as never);
    expect(response.status).toHaveBeenLastCalledWith(HttpStatus.OK);
  });

  it("serves the rest from the two services", async () => {
    const { controller: routes, compilations, series } = controller();
    await routes.list(WS, RUN);
    await routes.get(WS, RUN, ID);
    await routes.retry(WS, USER, RUN, ID);
    await expect(routes.remove(WS, USER, RUN, ID)).resolves.toEqual({ id: ID });
    expect(compilations.list).toHaveBeenCalledWith(WS, RUN);
    expect(compilations.retry).toHaveBeenCalledWith(WS, USER, RUN, ID);
    expect(compilations.remove).toHaveBeenCalledWith(WS, USER, RUN, ID);
    await routes.listSeries(WS, RUN);
    await routes.createSeries(WS, USER, RUN, { clipIds: [CLIP_A, CLIP_B] });
    await routes.removeSeries(WS, USER, RUN, ID);
    expect(series.create).toHaveBeenCalledWith(WS, USER, RUN, { clipIds: [CLIP_A, CLIP_B] });
    expect(series.remove).toHaveBeenCalledWith(WS, USER, RUN, ID);
  });

  it("lets viewers read, editors change, and rate-limits every change like a cut", () => {
    for (const name of ["list", "get", "listSeries"] as const) {
      expect(route(name).method, name).toBe(RequestMethod.GET);
      expect(route(name).roles, name).toEqual(["viewer"]);
    }
    for (const name of ["create", "retry", "remove", "createSeries", "removeSeries"] as const) {
      expect(route(name).roles, name).toEqual(["editor"]);
      expect(route(name).rateLimits, name).toEqual([CLIP_RATE_LIMITS.mutate]);
    }
    expect(route("create")).toMatchObject({
      path: ":runId/compilations",
      method: RequestMethod.POST,
    });
    expect(route("retry")).toMatchObject({
      path: ":runId/compilations/:compilationId/retry",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    expect(route("remove")).toMatchObject({
      path: ":runId/compilations/:compilationId",
      method: RequestMethod.DELETE,
    });
    expect(route("removeSeries")).toMatchObject({
      path: ":runId/series/:seriesId",
      method: RequestMethod.DELETE,
    });
  });

  it("sits behind the workspace membership guard", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      RepurposeCompilationsController,
    ) as unknown[];
    expect(guards).toContain(WorkspaceMemberGuard);
  });
});

describe("the request bodies", () => {
  it("takes two to twenty distinct clips, a shape, and a title of up to 80 characters", () => {
    const ok = { clipIds: [CLIP_A, CLIP_B], shape: "4:5", title: "Best of" };
    expect(createCompilationSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, clipIds: [CLIP_A] },
      { ...ok, clipIds: [CLIP_A, CLIP_A] },
      {
        ...ok,
        clipIds: Array.from({ length: 21 }, (_, i) => `01JCC11P${String(i).padStart(18, "0")}`),
      },
      { ...ok, shape: "3:2" },
      { ...ok, title: "x".repeat(81) },
      { ...ok, clipIds: ["../../x", CLIP_B] },
    ]) {
      expect(createCompilationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes two to ten distinct clips for a series", () => {
    expect(createSeriesSchema.safeParse({ clipIds: [CLIP_A, CLIP_B] }).success).toBe(true);
    expect(createSeriesSchema.safeParse({ clipIds: [CLIP_A] }).success).toBe(false);
    expect(
      createSeriesSchema.safeParse({
        clipIds: Array.from({ length: 11 }, (_, i) => `01JCC11P${String(i).padStart(18, "0")}`),
      }).success,
    ).toBe(false);
  });
});
