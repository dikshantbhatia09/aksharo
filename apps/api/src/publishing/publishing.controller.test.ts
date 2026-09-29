import { HttpStatus, RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { PublishingController, RepurposePublishingController } from "./publishing.controller.js";
import { dailyPostsSchema, publishClipSchema } from "./publishing.dto.js";
import { RATE_LIMIT_KEY, ROLES_KEY } from "../common/guards/index.js";
import { CLIP_RATE_LIMITS } from "../repurpose/repurpose-clips.dto.js";

// Nest's own metadata keys (`@nestjs/common/constants`), read the way the router does.
function route(target: object, name: string) {
  const handler = Object.getOwnPropertyDescriptor(target, name)?.value as object;
  return {
    path: Reflect.getMetadata("path", handler) as string,
    method: Reflect.getMetadata("method", handler) as RequestMethod,
    httpCode: Reflect.getMetadata("__httpCode__", handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
  };
}

describe("publishing routes", () => {
  it("serves status to viewers and the rest to editors, rate-limiting what can reach an account", () => {
    const workspace = PublishingController.prototype;
    expect(Reflect.getMetadata("path", PublishingController)).toBe("publishing");
    expect(route(workspace, "status")).toMatchObject({
      path: "status",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route(workspace, "channels")).toMatchObject({ path: "channels", roles: ["editor"] });
    expect(route(workspace, "cancel")).toMatchObject({
      path: "posts/:postId",
      method: RequestMethod.DELETE,
      roles: ["editor"],
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });
    expect(route(workspace, "retry")).toMatchObject({
      path: "posts/:postId/retry",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });

    const run = RepurposePublishingController.prototype;
    expect(Reflect.getMetadata("path", RepurposePublishingController)).toBe("repurpose/runs");
    expect(route(run, "plan")).toMatchObject({
      path: ":runId/clips/:clipId/publish-plan",
      method: RequestMethod.GET,
      roles: ["editor"],
    });
    expect(route(run, "publish")).toMatchObject({
      path: ":runId/clips/:clipId/posts",
      method: RequestMethod.POST,
      httpCode: HttpStatus.CREATED,
      roles: ["editor"],
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });
    expect(route(run, "list")).toMatchObject({ path: ":runId/posts", roles: ["viewer"] });
    expect(route(run, "daily")).toMatchObject({
      path: ":runId/posts/daily",
      method: RequestMethod.POST,
      rateLimits: [CLIP_RATE_LIMITS.mutate],
    });
  });

  it("passes the workspace from the token and the ids from the path to the service", async () => {
    const calls: unknown[][] = [];
    const service = new Proxy(
      {},
      {
        get:
          (_target, name) =>
          async (...args: unknown[]) => {
            calls.push([name, ...args]);
            return {};
          },
      },
    );
    const idempotency = { find: async () => undefined, save: async () => undefined };
    const workspace = new PublishingController(service as never);
    const run = new RepurposePublishingController(service as never, idempotency as never);
    await workspace.cancel("WS", "USER", "POST");
    await run.publish("WS", "USER", "RUN", "CLIP", { channelIds: [], when: { kind: "now" } }, {
      headers: {},
    } as never);
    await run.list("WS", "RUN", "CLIP");
    expect(calls).toEqual([
      ["cancel", "WS", "USER", "POST"],
      ["publish", "WS", "USER", "RUN", "CLIP", { channelIds: [], when: { kind: "now" } }],
      ["list", "WS", "RUN", "CLIP"],
    ]);
  });
});

describe("publishing bodies", () => {
  const channel = "01JCCHANNE0000000000000000";

  it("accepts now, a time with its offset, or the daily slot", () => {
    for (const when of [
      { kind: "now" },
      { kind: "at", at: "2026-10-02T19:00:00+05:30", timezone: "Asia/Kolkata" },
      { kind: "daily", time: "19:00" },
    ]) {
      expect(
        publishClipSchema.safeParse({ channelIds: [channel], when }).success,
        JSON.stringify(when),
      ).toBe(true);
    }
  });

  it("refuses no accounts, an unknown 'when', a clock that is not HH:MM, and too many clips", () => {
    expect(publishClipSchema.safeParse({ channelIds: [], when: { kind: "now" } }).success).toBe(
      false,
    );
    expect(
      publishClipSchema.safeParse({ channelIds: [channel], when: { kind: "soon" } }).success,
    ).toBe(false);
    expect(
      publishClipSchema.safeParse({ channelIds: [channel], when: { kind: "daily", time: "7pm" } })
        .success,
    ).toBe(false);
    expect(
      dailyPostsSchema.safeParse({ clipIds: Array(41).fill(channel), channelIds: [channel] })
        .success,
    ).toBe(false);
  });
});
