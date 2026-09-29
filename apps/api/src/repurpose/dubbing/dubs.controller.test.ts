import { HttpStatus, RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";

import { RepurposeDubsController } from "./dubs.controller.js";
import { createDubSchema } from "./dubs.dto.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../../common/guards/index.js";
import { WorkspaceMemberGuard } from "../../workspaces/workspace-member.guard.js";
import { CLIP_RATE_LIMITS } from "../repurpose-clips.dto.js";

const WS = "01JCWS0000000000000000000A";
const USER = "01JCUSER000000000000000000";
const RUN = "01JCRN0000000000000000000A";
const CLIP = "01JCC11PA00000000000000000";
const DUB = "01JCDVB0000000000000000000";

function route(name: keyof RepurposeDubsController) {
  const handler = Object.getOwnPropertyDescriptor(RepurposeDubsController.prototype, name)
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
  const dubs = {
    list: vi.fn(async () => ({ runId: RUN, dubs: [] })),
    create: vi.fn(async () => ({ dub: { id: DUB }, created: true })),
    retry: vi.fn(async () => ({ id: DUB })),
    cancel: vi.fn(async () => ({ id: DUB })),
  };
  return { dubs, controller: new RepurposeDubsController(dubs as never) };
}

describe("RepurposeDubsController (2026-10-04)", () => {
  it("answers a new dub 201 and the same languages asked again 200", async () => {
    const { controller: routes, dubs } = controller();
    const response = { status: vi.fn() };
    const body = { languages: ["hi-IN" as const], consent: true };
    await expect(routes.create(WS, USER, RUN, CLIP, body, response as never)).resolves.toEqual({
      id: DUB,
    });
    expect(dubs.create).toHaveBeenCalledWith(WS, USER, RUN, CLIP, body);
    expect(response.status).toHaveBeenLastCalledWith(HttpStatus.CREATED);
    dubs.create.mockResolvedValueOnce({ dub: { id: DUB }, created: false });
    await routes.create(WS, USER, RUN, CLIP, body, response as never);
    expect(response.status).toHaveBeenLastCalledWith(HttpStatus.OK);
  });

  it("serves list, retry and cancel from the service", async () => {
    const { controller: routes, dubs } = controller();
    await routes.list(WS, RUN);
    await routes.retry(WS, USER, RUN, DUB);
    await routes.cancel(WS, USER, RUN, DUB);
    expect(dubs.list).toHaveBeenCalledWith(WS, RUN);
    expect(dubs.retry).toHaveBeenCalledWith(WS, USER, RUN, DUB);
    expect(dubs.cancel).toHaveBeenCalledWith(WS, USER, RUN, DUB);
  });

  it("lets viewers read, editors dub, and rate-limits every change like a cut", () => {
    expect(route("list")).toMatchObject({
      path: ":runId/dubs",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    for (const name of ["create", "retry", "cancel"] as const) {
      expect(route(name).roles, name).toEqual(["editor"]);
      expect(route(name).rateLimits, name).toEqual([CLIP_RATE_LIMITS.mutate]);
      expect(route(name).method, name).toBe(RequestMethod.POST);
    }
    expect(route("create").path).toBe(":runId/clips/:clipId/dubs");
    expect(route("retry")).toMatchObject({
      path: ":runId/dubs/:dubId/retry",
      httpCode: HttpStatus.OK,
    });
    expect(route("cancel")).toMatchObject({
      path: ":runId/dubs/:dubId/cancel",
      httpCode: HttpStatus.OK,
    });
  });

  it("sits behind the workspace membership guard", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, RepurposeDubsController) as unknown[];
    expect(guards).toContain(WorkspaceMemberGuard);
  });
});

describe("the request body", () => {
  it("takes one to eleven distinct vendor languages and a consent flag", () => {
    expect(
      createDubSchema.safeParse({ languages: ["hi-IN", "ta-IN"], consent: true }).success,
    ).toBe(true);
    // An unticked box parses, so the service can refuse it in its own words.
    expect(createDubSchema.safeParse({ languages: ["hi-IN"], consent: false }).success).toBe(true);
    for (const bad of [
      { languages: [], consent: true },
      { languages: ["hi-IN", "hi-IN"], consent: true },
      { languages: ["od-IN"], consent: true },
      { languages: ["hi-IN"] },
      { languages: ["hi-IN"], consent: "yes" },
    ]) {
      expect(createDubSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
