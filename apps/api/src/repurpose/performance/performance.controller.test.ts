import { resolve } from "node:path";

import { HttpStatus, RequestMethod } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { ClipPostsService } from "./clip-posts.service.js";
import {
  POSTIZ_ANALYTICS,
  POSTIZ_READ_BUDGET,
  PerformanceRefresher,
  VIEW_READER,
} from "./performance-refresher.js";
import { PERFORMANCE_RATE_LIMITS } from "./performance.constants.js";
import { RepurposePerformanceController, WhatWorksController } from "./performance.controller.js";
import { addPostSchema, enterNumbersSchema, whatWorksQuerySchema } from "./performance.dto.js";
import { PERFORMANCE_PROVIDERS } from "./performance.module.js";
import { ReadBudget } from "./read-budget.js";
import { WhatWorksService } from "./what-works.service.js";
import { YouTubeViewReader } from "./youtube-views.js";
import { createFakeRedis } from "../../../test/fakes.js";
import { findUnauditedControllers, scanControllerFile } from "../../audit/audited-routes.scan.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../../common/guards/index.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { PostizClient } from "../../publishing/postiz/postiz.client.js";
import { RepurposeService } from "../repurpose.service.js";

const WS = "01JPC0WS000000000000000001";
const USER = "01JPC0USER0000000000000001";
const RUN = "01JPC0RUN00000000000000001";
const CLIP = "01JPC0CLIP0000000000000001";
const POST = "01JPC0POST0000000000000001";

// Nest's own metadata keys (`@nestjs/common/constants`), read the way the router does.
function route(controller: object, name: string) {
  const handler = Object.getOwnPropertyDescriptor(controller, name)?.value as object;
  return {
    path: Reflect.getMetadata("path", handler) as string,
    method: Reflect.getMetadata("method", handler) as RequestMethod,
    httpCode: Reflect.getMetadata("__httpCode__", handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
  };
}

describe("RepurposePerformanceController", () => {
  it("mounts beside the run's routes: viewers read, editors change, every change rate-limited", () => {
    expect(Reflect.getMetadata("path", RepurposePerformanceController)).toBe("repurpose/runs");
    const proto = RepurposePerformanceController.prototype;
    expect(route(proto, "list")).toMatchObject({
      path: ":runId/performance",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route(proto, "add")).toMatchObject({
      path: ":runId/clips/:clipId/performance/posts",
      method: RequestMethod.POST,
      httpCode: HttpStatus.CREATED,
    });
    expect(route(proto, "remove")).toMatchObject({
      path: ":runId/performance/posts/:postId",
      method: RequestMethod.DELETE,
    });
    expect(route(proto, "numbers")).toMatchObject({
      path: ":runId/performance/posts/:postId/numbers",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    for (const name of ["add", "remove", "numbers"]) {
      expect(route(proto, name).roles, name).toEqual(["editor"]);
      expect(route(proto, name).rateLimits, name).toEqual([PERFORMANCE_RATE_LIMITS.mutate]);
    }
  });

  it("hands each route to the service with the token's workspace and user", async () => {
    const service = {
      runPerformance: vi.fn(async () => ({})),
      addLink: vi.fn(async () => ({})),
      removePost: vi.fn(async () => ({ removed: true })),
      enterNumbers: vi.fn(async () => ({})),
    };
    const controller = new RepurposePerformanceController(service as never);
    await controller.list(WS, RUN);
    expect(service.runPerformance).toHaveBeenCalledWith(WS, RUN);
    await controller.add(WS, USER, RUN, CLIP, { url: "https://youtu.be/dQw4w9WgXcQ" });
    expect(service.addLink).toHaveBeenCalledWith(WS, USER, RUN, CLIP, {
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    await controller.remove(WS, USER, RUN, POST);
    expect(service.removePost).toHaveBeenCalledWith(WS, USER, RUN, POST);
    await controller.numbers(WS, USER, RUN, POST, { views: 10 });
    expect(service.enterNumbers).toHaveBeenCalledWith(WS, USER, RUN, POST, { views: 10 });
  });
});

describe("WhatWorksController", () => {
  it("mounts GET /repurpose/performance/what-works for viewers", async () => {
    expect(Reflect.getMetadata("path", WhatWorksController)).toBe("repurpose/performance");
    expect(route(WhatWorksController.prototype, "get")).toMatchObject({
      path: "what-works",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    const service = { whatWorks: vi.fn(async () => ({})) };
    await new WhatWorksController(service as never).get(WS, { days: 30 });
    expect(service.whatWorks).toHaveBeenCalledWith(WS, 30);
  });
});

describe("the request bodies", () => {
  it("take a link with an optional shape, language and day, and nothing else", () => {
    expect(
      addPostSchema.safeParse({
        url: " https://youtu.be/dQw4w9WgXcQ ",
        shape: "4:5",
        language: "hi-IN",
        postedAt: "2026-10-04",
      }).success,
    ).toBe(true);
    expect(
      addPostSchema.safeParse({ url: "x", postedAt: "2026-10-04T19:30:00+05:30" }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { url: "" },
      { url: "x", shape: "3:4" },
      { url: "x", postedAt: "yesterday" },
      { url: "x", extra: true },
    ]) {
      expect(addPostSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("take whole, non-negative counts only", () => {
    expect(enterNumbersSchema.safeParse({ views: 0, likes: 12 }).success).toBe(true);
    for (const bad of [{ views: -1 }, { likes: 1.5 }, { shares: 3_000_000_000 }, { saves: 1 }]) {
      expect(enterNumbersSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("read the What works window as 30, 90 or 365 days, 90 by default", () => {
    expect(whatWorksQuerySchema.parse({})).toEqual({ days: 90 });
    expect(whatWorksQuerySchema.parse({ days: "365" })).toEqual({ days: 365 });
    expect(whatWorksQuerySchema.safeParse({ days: "7" }).success).toBe(false);
  });
});

describe("the audit contract", () => {
  it("finds an audit writer behind the performance controllers", () => {
    const srcRoot = resolve(__dirname, "../..");
    const scanned = scanControllerFile(resolve(__dirname, "performance.controller.ts"), srcRoot);
    expect(scanned).toMatchObject({ hasMutatingRoute: true, referencesAuditWriter: true });
    expect(
      findUnauditedControllers(srcRoot).filter((entry) => entry.file.includes("performance")),
    ).toEqual([]);
  });
});

describe("RepurposePerformanceModule providers", () => {
  it("resolve with the global and imported providers stubbed, and register the task", async () => {
    const scheduler = { register: vi.fn(), scheduled: [] };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...PERFORMANCE_PROVIDERS,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: createFakeRedis() },
        { provide: RepurposeService, useValue: {} },
        { provide: CommonAuditService, useValue: {} },
        { provide: ScheduledTasksService, useValue: scheduler },
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(ClipPostsService)).toBeInstanceOf(ClipPostsService);
    expect(moduleRef.get(WhatWorksService)).toBeInstanceOf(WhatWorksService);
    expect(moduleRef.get(PerformanceRefresher)).toBeInstanceOf(PerformanceRefresher);
    expect(moduleRef.get(POSTIZ_ANALYTICS)).toBe(moduleRef.get(PostizClient));
    expect(moduleRef.get(VIEW_READER)).toBeInstanceOf(YouTubeViewReader);
    expect(moduleRef.get(POSTIZ_READ_BUDGET)).toBeInstanceOf(ReadBudget);
    expect(scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: "repurpose.performance-refresh" }),
    );
    await moduleRef.close();
  });
});
