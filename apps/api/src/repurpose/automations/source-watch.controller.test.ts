import { resolve } from "node:path";

import { HttpStatus, RequestMethod } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTOMATIONS_PROVIDERS } from "./automations.module.js";
import { BulkRunsService } from "./bulk-runs.service.js";
import { AUTOMATION_RATE_LIMITS } from "./source-watch.constants.js";
import { BulkRunsController, SourceWatchController } from "./source-watch.controller.js";
import { SourceWatchPoller } from "./source-watch.poller.js";
import { SourceWatchService } from "./source-watch.service.js";
import { WatchNotifier } from "./watch-notices.js";
import { CHANNEL_DIRECTORY, YouTubeChannelDirectory } from "./youtube-channels.js";
import { createFakeRedis } from "../../../test/fakes.js";
import { findUnauditedControllers, scanControllerFile } from "../../audit/audited-routes.scan.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../../common/guards/index.js";
import { RateLimitService } from "../../common/guards/rate-limit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { ENV } from "../../config/config.module.js";
import { NotifyService } from "../../notify/notify.service.js";
import { StylesService } from "../../styles/styles.service.js";
import { RepurposeService } from "../repurpose.service.js";

const WS = "01JWS00000000000000000000A";
const USER = "01JUSER0000000000000000000";
const WATCH = "01JWATCH000000000000000000";

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

describe("SourceWatchController", () => {
  it("mounts under /repurpose/watches: editors change, viewers read, every change rate-limited", () => {
    expect(Reflect.getMetadata("path", SourceWatchController)).toBe("repurpose/watches");
    const proto = SourceWatchController.prototype;
    expect(route(proto, "resolve")).toMatchObject({
      path: "resolve",
      method: RequestMethod.POST,
      roles: ["editor"],
      httpCode: HttpStatus.OK,
      rateLimits: [AUTOMATION_RATE_LIMITS.resolve],
    });
    expect(route(proto, "list")).toMatchObject({
      path: "/",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route(proto, "get")).toMatchObject({
      path: ":watchId",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route(proto, "create")).toMatchObject({
      path: "/",
      method: RequestMethod.POST,
      roles: ["editor"],
      httpCode: HttpStatus.CREATED,
    });
    expect(route(proto, "update")).toMatchObject({ path: ":watchId", method: RequestMethod.PATCH });
    expect(route(proto, "pause")).toMatchObject({
      path: ":watchId/pause",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    expect(route(proto, "resume")).toMatchObject({
      path: ":watchId/resume",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
    });
    expect(route(proto, "remove")).toMatchObject({
      path: ":watchId",
      method: RequestMethod.DELETE,
    });
    for (const name of ["create", "update", "pause", "resume", "remove"]) {
      expect(route(proto, name).roles, name).toEqual(["editor"]);
      expect(route(proto, name).rateLimits, name).toEqual([AUTOMATION_RATE_LIMITS.mutate]);
    }
  });

  it("hands each route to the service with the token's workspace and user", async () => {
    const service = {
      resolve: vi.fn(async () => ({})),
      list: vi.fn(async () => ({})),
      get: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      pause: vi.fn(async () => ({})),
      resume: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({})),
    };
    const controller = new SourceWatchController(service as never);
    await controller.resolve(WS, { url: "https://www.youtube.com/@x_y" });
    expect(service.resolve).toHaveBeenCalledWith(WS, "https://www.youtube.com/@x_y");
    await controller.list(WS);
    expect(service.list).toHaveBeenCalledWith(WS);
    await controller.pause(WS, USER, WATCH);
    expect(service.pause).toHaveBeenCalledWith(WS, USER, WATCH);
    await controller.resume(WS, USER, WATCH);
    expect(service.resume).toHaveBeenCalledWith(WS, USER, WATCH);
    await controller.remove(WS, USER, WATCH);
    expect(service.remove).toHaveBeenCalledWith(WS, USER, WATCH);
  });
});

describe("BulkRunsController", () => {
  it("mounts POST /repurpose/runs/bulk for editors, on its own small bucket", () => {
    expect(Reflect.getMetadata("path", BulkRunsController)).toBe("repurpose/runs");
    expect(route(BulkRunsController.prototype, "startMany")).toMatchObject({
      path: "bulk",
      method: RequestMethod.POST,
      roles: ["editor"],
      httpCode: HttpStatus.OK,
      rateLimits: [AUTOMATION_RATE_LIMITS.bulk],
    });
  });
});

describe("the audit contract", () => {
  it("finds an audit writer behind both controllers", () => {
    // As `audit-completeness.test.ts` finds it: this app builds to CommonJS.
    const srcRoot = resolve(__dirname, "../..");
    const scanned = scanControllerFile(resolve(__dirname, "source-watch.controller.ts"), srcRoot);
    expect(scanned).toMatchObject({ hasMutatingRoute: true, referencesAuditWriter: true });
    expect(
      findUnauditedControllers(srcRoot).filter((entry) => entry.file.includes("automations")),
    ).toEqual([]);
  });
});

describe("RepurposeAutomationsModule providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolve with the global and imported providers stubbed, and register the task", async () => {
    const scheduler = { register: vi.fn(), scheduled: [] };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ...AUTOMATIONS_PROVIDERS,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: createFakeRedis() },
        { provide: RepurposeService, useValue: {} },
        { provide: StylesService, useValue: {} },
        { provide: CommonAuditService, useValue: {} },
        { provide: ScheduledTasksService, useValue: scheduler },
        { provide: NotifyService, useValue: {} },
        { provide: RateLimitService, useValue: {} },
        { provide: ENV, useValue: { WEB_ORIGIN: "https://web.test", FEATURE_FLAGS_JSON: {} } },
      ],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(SourceWatchService)).toBeInstanceOf(SourceWatchService);
    expect(moduleRef.get(SourceWatchPoller)).toBeInstanceOf(SourceWatchPoller);
    expect(moduleRef.get(WatchNotifier)).toBeInstanceOf(WatchNotifier);
    expect(moduleRef.get(BulkRunsService)).toBeInstanceOf(BulkRunsService);
    expect(moduleRef.get(CHANNEL_DIRECTORY)).toBeInstanceOf(YouTubeChannelDirectory);
    expect(scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: "repurpose.source-watch" }),
    );
    await moduleRef.close();
  });
});
