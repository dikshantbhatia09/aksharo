import { HttpStatus, RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { GuestLinksController } from "./guest-links.controller.js";
import { GUEST_RATE_LIMITS } from "./guest.constants.js";
import { GuestDownloadDto, guestDownloadSchema } from "./guest.dto.js";
import { GUEST_TOKEN_HEADER, PublicGuestController } from "./public-guest.controller.js";
import { IS_PUBLIC_KEY, RATE_LIMIT_KEY, ROLES_KEY } from "../../common/guards/index.js";
import { REVIEW_TOKEN_HEADER } from "../review/public-review.controller.js";

import type { GuestPageService } from "./guest-page.service.js";

// Nest's own metadata keys (`@nestjs/common/constants`), read the way the router does.
function route(target: object, name: string) {
  const handler = Object.getOwnPropertyDescriptor(target, name)?.value as object;
  return {
    path: Reflect.getMetadata("path", handler) as string,
    method: Reflect.getMetadata("method", handler) as RequestMethod,
    httpCode: Reflect.getMetadata("__httpCode__", handler) as number | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    rateLimits: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as unknown[] | undefined,
    isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) as boolean | undefined,
  };
}

describe("the team's guest link routes", () => {
  const team = GuestLinksController.prototype;

  it("sit beside the run routes, and take an editor to list, make or revoke", () => {
    expect(Reflect.getMetadata("path", GuestLinksController)).toBe("repurpose/runs");
    expect(route(team, "list")).toMatchObject({
      path: ":runId/guest-links",
      method: RequestMethod.GET,
      roles: ["editor"],
    });
    expect(route(team, "create")).toMatchObject({
      path: ":runId/guest-links",
      method: RequestMethod.POST,
      httpCode: HttpStatus.CREATED,
      roles: ["editor"],
      rateLimits: [GUEST_RATE_LIMITS.mutate],
    });
    expect(route(team, "revoke")).toMatchObject({
      path: ":runId/guest-links/:linkId",
      method: RequestMethod.DELETE,
      roles: ["editor"],
      rateLimits: [GUEST_RATE_LIMITS.mutate],
    });
    for (const name of ["list", "create", "revoke"]) {
      expect(route(team, name).isPublic, name).toBeUndefined();
    }
  });

  it("passes the workspace from the token and the caller to the service", async () => {
    const calls: unknown[][] = [];
    const service = new Proxy(
      {},
      {
        get:
          (_target, name) =>
          async (...args: unknown[]) => {
            calls.push([name, ...args]);
            return [];
          },
      },
    );
    const controller = new GuestLinksController(service as never);
    const principal = { userId: "U", role: "editor", workspaceId: "WS" } as never;
    const body = { allClips: true, clipIds: [], expiresInDays: 14, includeDubs: false };
    await controller.create("WS", principal, "RUN", body);
    await controller.list("WS", "RUN");
    await controller.revoke("WS", principal, "RUN", "LINK");
    expect(calls).toEqual([
      ["createLink", "WS", principal, "RUN", body],
      ["listLinks", "WS", "RUN"],
      ["revokeLink", "WS", principal, "RUN", "LINK"],
    ]);
  });
});

describe("the guest's routes", () => {
  const guest = PublicGuestController.prototype;

  it("are public, rate-limited by address, and take the token in a header of their own", () => {
    expect(Reflect.getMetadata("path", PublicGuestController)).toBe("guest");
    expect(route(guest, "open")).toMatchObject({
      path: "/",
      method: RequestMethod.GET,
      isPublic: true,
      rateLimits: [GUEST_RATE_LIMITS.publicRead],
    });
    expect(route(guest, "download")).toMatchObject({
      path: "downloads",
      method: RequestMethod.POST,
      httpCode: HttpStatus.NO_CONTENT,
      isPublic: true,
      rateLimits: [GUEST_RATE_LIMITS.publicDownload],
    });
    expect(GUEST_TOKEN_HEADER).toBe("x-guest-token");
    expect(GUEST_TOKEN_HEADER).not.toBe(REVIEW_TOKEN_HEADER);
    // Buckets of their own: a review page's reads never spend a guest's.
    expect(GUEST_RATE_LIMITS.publicRead.name).toBe("guest:read:ip");
  });

  it("answer 404 while public links are off, and hand the token and address on otherwise", async () => {
    const calls: unknown[][] = [];
    const pages = {
      open: async (token: string) => {
        calls.push(["open", token]);
        return {};
      },
      countDownload: async (...args: unknown[]) => {
        calls.push(["countDownload", ...args]);
      },
    } as unknown as GuestPageService;
    const off = new PublicGuestController(pages, {
      FEATURE_FLAGS_JSON: { "shares.public": false },
    } as unknown as Env);
    await expect(off.open("T".repeat(24))).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);

    const on = new PublicGuestController(pages, {
      FEATURE_FLAGS_JSON: { "shares.public": true },
    } as unknown as Env);
    await on.open(undefined);
    const body = { clipId: "01JRV0000000000000000000K1", file: "video" } as const;
    await on.download("T".repeat(24), body, {
      ip: "203.0.113.7",
      headers: {},
      socket: { remoteAddress: "203.0.113.7" },
    } as never);
    expect(calls[0]).toEqual(["open", ""]);
    expect(calls[1]?.[0]).toBe("countDownload");
    expect(calls[1]?.[1]).toBe("T".repeat(24));
    expect(calls[1]?.[2]).toEqual(body);
    expect(calls[1]?.[3]).toEqual({ ip: "203.0.113.7" });
  });

  it("validate what a counted download names", () => {
    expect(GuestDownloadDto).toBeDefined();
    expect(
      guestDownloadSchema.safeParse({ clipId: "01JRV0000000000000000000K1", file: "video" })
        .success,
    ).toBe(true);
    for (const bad of [
      { clipId: "../../etc", file: "video" },
      { clipId: "01JRV0000000000000000000K1", file: "original" },
      { clipId: "01JRV0000000000000000000K1", file: "video", shape: "3:2" },
      { clipId: "01JRV0000000000000000000K1", file: "image", image: "poster" },
      { clipId: "01JRV0000000000000000000K1", file: "dub", language: "fr-FR" },
    ]) {
      expect(guestDownloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
