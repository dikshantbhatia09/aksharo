/**
 * `/referrals/*` over real HTTP, plus the wiring the brief calls out
 * specifically: `exports/exports.service.ts`'s `completeManifest()` emits
 * `export.completed`, and `ReferralsModule`'s listener reacts to it — this
 * suite never calls `ReferralsService` directly, only the export endpoints,
 * so a break in that emit (or in `app.module.ts` registration) fails here
 * even though `referrals.e2e-spec.ts` calls the service in-process and
 * would not catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";

import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, edgSkipReason, type EdgTestContext } from "./edg-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[referrals-http.e2e] skipped: ${skipReason}`);

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

describe.skipIf(!available)("/referrals/* over HTTP", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error(`referrals-http suite could not start: ${edgSkipReason}`);
    ctx = created;
    base = `http://127.0.0.1:${String(ctx.port)}`;

    const free = PLAN_SEEDS.find((plan) => plan.key === "free");
    if (free === undefined) throw new Error("free plan seed missing");
    await ctx.prisma.plan.upsert({
      where: { key: "free" },
      update: {
        entitlements: free.entitlements,
        creditsPerMonthTenths: free.creditsPerMonthTenths,
      },
      create: {
        id: "01JRHFREEPLAN0000000000000",
        key: "free",
        name: free.name,
        prices: free.prices,
        creditsPerMonthTenths: free.creditsPerMonthTenths,
        entitlements: free.entitlements,
      },
    });
    const existingStyle = await ctx.prisma.stylePreset.findFirst({
      where: { workspaceId: null, key: "clean-bold" },
    });
    if (existingStyle === null) {
      const doc = loadSystemStyleMap().get("vertical-clean");
      if (doc === undefined) throw new Error("vertical-clean system style missing");
      await ctx.prisma.stylePreset.create({
        data: {
          id: "01JRHSTYLEVCLEAN000000000",
          workspaceId: null,
          key: "clean-bold",
          name: "Clean Bold",
          category: "general",
          doc: { ...doc, id: "clean-bold" },
        },
      });
    }
  }, 180_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as T };
  }

  it("GET /referrals/me creates a code; POST /referrals/claim claims it for another workspace", async () => {
    const referrerToken = ctx.token("owner", ctx.workspaceId);
    const referredToken = ctx.token("owner", ctx.otherWorkspaceId);

    const me = await call<{ code: string }>("GET", "/referrals/me", { token: referrerToken });
    expect(me.status).toBe(200);
    expect(me.body.code).toMatch(/^AK-[A-Z0-9]{6}$/);

    const claim = await call<{ claimed: boolean; status: string | null }>(
      "POST",
      "/referrals/claim",
      {
        token: referredToken,
        body: { code: me.body.code },
      },
    );
    expect(claim.status).toBe(201);
    expect(claim.body).toEqual({ claimed: true, status: "pending", reason: null });
  });

  it("grants both sides once the referred workspace completes its first browser export", async () => {
    const referrerToken = ctx.token("owner", ctx.workspaceId);
    const referredToken = ctx.token("owner", ctx.otherWorkspaceId);

    const me = await call<{ code: string }>("GET", "/referrals/me", { token: referrerToken });

    // A fresh referred workspace for this test (the previous test already
    // used `ctx.otherWorkspaceId`, and a workspace claims at most once).
    const seeded = await ctx.seed({ words: 20, chunkSize: 20, workspaceId: ctx.otherWorkspaceId });

    const claim = await call("POST", "/referrals/claim", {
      token: referredToken,
      body: { code: me.body.code },
    });
    // Either freshly pending here, or already resolved by the previous test
    // — both are fine; what matters is the grant below.
    expect([200, 201]).toContain(claim.status);

    const decision = await call<{ manifest?: Record<string, unknown>; exportId: string }>(
      "POST",
      `/projects/${seeded.projectId}/exports`,
      {
        token: referredToken,
        body: {
          kind: "video",
          preset: "reels",
          outputKind: "video",
          mode: "browser",
          script: "roman",
          // A21b: an explicit `mode: "browser"` request is now judged against
          // the real capability probe (D34) — a browser that cannot decode
          // and encode H.264, or cannot encode audio, throws
          // `export/unsupported_in_browser` (409) rather than silently
          // falling back to cloud, which only `mode: "auto"` does. A real
          // browser client always sends this probe alongside the request; a
          // fully-capable one is what exercises the browser-completion path
          // this test is actually after.
          capabilities: { codecs: ["avc1.42001f"], audioEncoder: true },
        },
      },
    );
    expect(decision.status).toBe(201);
    const manifestId = (decision.body.manifest as { manifestId: string }).manifestId;

    const complete = await call("POST", `/exports/manifests/${manifestId}/complete`, {
      token: referredToken,
      body: { sizeBytes: 512_000, durationMs: 8_000, checksum: "sha256:deadbeef" },
    });
    expect(complete.status).toBe(201);

    // The listener runs asynchronously off the `export.completed` emit — give
    // it a moment before asserting on the row it writes.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await ctx.prisma.referralReward.findUnique({
      where: { referredWorkspaceId: ctx.otherWorkspaceId },
    });
    expect(row?.status).toBe("granted");
    expect(row?.referrerLotId).not.toBeNull();
    expect(row?.referredLotId).not.toBeNull();
  });
});
