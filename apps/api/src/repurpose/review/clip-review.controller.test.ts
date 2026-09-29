import { HttpStatus, RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { ClipReviewController } from "./clip-review.controller.js";
import { PublicReviewController, REVIEW_TOKEN_HEADER } from "./public-review.controller.js";
import { REVIEW_RATE_LIMITS } from "./review.constants.js";
import {
  clientCommentSchema,
  clientDecisionSchema,
  createReviewLinkSchema,
  reviewDecisionSchema,
} from "./review.dto.js";
import { IS_PUBLIC_KEY, RATE_LIMIT_KEY, ROLES_KEY } from "../../common/guards/index.js";

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

describe("the team's review routes", () => {
  const team = ClipReviewController.prototype;

  it("sit beside the run routes, readable by everyone, changed by the role each needs", () => {
    expect(Reflect.getMetadata("path", ClipReviewController)).toBe("repurpose/runs");
    expect(route(team, "runReview")).toMatchObject({
      path: ":runId/review",
      method: RequestMethod.GET,
      roles: ["viewer"],
    });
    expect(route(team, "clipReview")).toMatchObject({
      path: ":runId/clips/:clipId/review",
      roles: ["viewer"],
    });
    // Editors ask for changes; approving is checked again in the service.
    expect(route(team, "decide")).toMatchObject({
      path: ":runId/clips/:clipId/review",
      method: RequestMethod.POST,
      httpCode: HttpStatus.OK,
      roles: ["editor"],
      rateLimits: [REVIEW_RATE_LIMITS.mutate],
    });
    expect(route(team, "addComment")).toMatchObject({
      path: ":runId/clips/:clipId/comments",
      httpCode: HttpStatus.CREATED,
      roles: ["viewer"],
    });
    expect(route(team, "resolveComment")).toMatchObject({
      path: ":runId/clips/:clipId/comments/:commentId",
      method: RequestMethod.PATCH,
      roles: ["viewer"],
    });
    expect(route(team, "links")).toMatchObject({ path: ":runId/review-links", roles: ["editor"] });
    // A link lets its client approve: owners and admins only.
    expect(route(team, "createLink")).toMatchObject({
      path: ":runId/review-links",
      method: RequestMethod.POST,
      roles: ["admin"],
      rateLimits: [REVIEW_RATE_LIMITS.mutate],
    });
    expect(route(team, "revokeLink")).toMatchObject({
      path: ":runId/review-links/:linkId",
      method: RequestMethod.DELETE,
      roles: ["editor"],
    });
    for (const name of ["runReview", "decide", "createLink"]) {
      expect(route(team, name).isPublic, name).toBeUndefined();
    }
  });

  it("passes the workspace from the token and the caller's live role to the service", async () => {
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
    const controller = new ClipReviewController(service as never);
    const principal = { userId: "U", role: "editor", workspaceId: "WS" } as never;
    await controller.decide("WS", principal, "RUN", "CLIP", { decision: "changes_requested" });
    await controller.links("WS", "RUN");
    expect(calls).toEqual([
      ["decideAsMember", "WS", principal, "RUN", "CLIP", { decision: "changes_requested" }],
      ["listLinks", "WS", "RUN"],
    ]);
  });
});

describe("the client's review routes", () => {
  const client = PublicReviewController.prototype;

  it("are public, rate-limited by address, and never cached", () => {
    expect(Reflect.getMetadata("path", PublicReviewController)).toBe("review");
    expect(route(client, "open")).toMatchObject({
      path: "/",
      method: RequestMethod.GET,
      isPublic: true,
      rateLimits: [REVIEW_RATE_LIMITS.publicRead],
    });
    expect(route(client, "decide")).toMatchObject({
      path: "clips/:clipId/decision",
      httpCode: HttpStatus.OK,
      isPublic: true,
      rateLimits: [REVIEW_RATE_LIMITS.publicWrite],
    });
    expect(route(client, "comment")).toMatchObject({
      path: "clips/:clipId/comments",
      httpCode: HttpStatus.CREATED,
      isPublic: true,
      rateLimits: [REVIEW_RATE_LIMITS.publicWrite],
    });
    for (const name of ["open", "decide", "comment"]) {
      const handler = Object.getOwnPropertyDescriptor(client, name)?.value as object;
      const headers = Reflect.getMetadata("__headers__", handler) as {
        name: string;
        value: string;
      }[];
      expect(headers, name).toContainEqual({ name: "Cache-Control", value: "no-store" });
    }
    expect(REVIEW_TOKEN_HEADER).toBe("x-review-token");
  });

  it("answer 404 while public links are off, before looking at the token", async () => {
    let asked = false;
    const service = {
      open: async () => {
        asked = true;
        return {};
      },
    };
    const off = new PublicReviewController(
      service as never,
      {
        FEATURE_FLAGS_JSON: { "shares.public": false },
      } as unknown as Env,
    );
    await expect(off.open("A".repeat(24))).rejects.toMatchObject({ status: 404 });
    expect(asked).toBe(false);

    const on = new PublicReviewController(
      service as never,
      {
        FEATURE_FLAGS_JSON: { "shares.public": true },
      } as unknown as Env,
    );
    await on.open(undefined);
    expect(asked).toBe(true);
  });
});

describe("review bodies", () => {
  it("take a decision with an optional note and the videos the page showed", () => {
    expect(
      reviewDecisionSchema.safeParse({ decision: "approved", expect: { "9:16": "E1" } }).success,
    ).toBe(true);
    expect(reviewDecisionSchema.safeParse({ decision: "maybe" }).success).toBe(false);
    expect(
      reviewDecisionSchema.safeParse({ decision: "approved", expect: { "3:2": "E1" } }).success,
    ).toBe(false);
    expect(
      reviewDecisionSchema.safeParse({ decision: "changes_requested", note: "x".repeat(2_001) })
        .success,
    ).toBe(false);
  });

  it("keep a link between one and thirty days, seven unless asked", () => {
    expect(createReviewLinkSchema.parse({})).toEqual({ expiresInDays: 7, requireName: false });
    expect(createReviewLinkSchema.safeParse({ expiresInDays: 0 }).success).toBe(false);
    expect(createReviewLinkSchema.safeParse({ expiresInDays: 31 }).success).toBe(false);
    expect(createReviewLinkSchema.safeParse({ expiresInDays: 30 }).success).toBe(true);
  });

  it("clean a client's name, and refuse one that is empty once cleaned", () => {
    expect(
      clientDecisionSchema.parse({ decision: "approved", name: "  Priya\u0000  \n Sharma " }).name,
    ).toBe("Priya Sharma");
    expect(clientDecisionSchema.safeParse({ decision: "approved", name: " \u0007 " }).success).toBe(
      false,
    );
    expect(clientCommentSchema.safeParse({ body: "Nice", name: "x".repeat(61) }).success).toBe(
      false,
    );
    expect(clientCommentSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(clientCommentSchema.safeParse({ body: "Nice", atMs: -1 }).success).toBe(false);
  });
});
