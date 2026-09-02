/**
 * The exports surface against a real PostgreSQL and a real Redis: the browser
 * manifest path end to end.
 *
 * ```
 * POST /projects/{id}/exports  mode:"browser" → signed RenderManifest, exports row pending_browser
 * POST /exports/manifests/{id}/complete        → succeeded, signup gift consumed, publish_events written
 *   … replayed                                 → 409 export/manifest_already_consumed
 * POST /exports/manifests/{id}/complete  (expired) → 410 export/manifest_expired
 * GET  /projects/{id}/exports                  → the list
 * GET  /exports/{id}/download                  → 409 export/not_ready — a browser export never uploads
 * ```
 *
 * The cloud render path — the real `apps/render` worker, ffmpeg, MinIO — is
 * `exports-render.e2e-spec.ts`; this suite needs only Postgres and Redis and
 * skips loudly without either, exactly as `edg.e2e-spec.ts` does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { verifyRenderManifest } from "@montaj/render-manifest";

import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, edgSkipReason, type EdgTestContext } from "./edg-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[exports.e2e] skipped: ${skipReason}`);

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

describe.skipIf(!available)("exports — browser manifest path", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error(`exports suite could not start: ${edgSkipReason}`);
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
        id: "01JEXPFREEPLAN00000000000",
        key: "free",
        name: free.name,
        prices: free.prices,
        creditsPerMonthTenths: free.creditsPerMonthTenths,
        entitlements: free.entitlements,
      },
    });
    // `EdgService.initialise` defaults an uncaptioned document's style to
    // "clean-bold" (its own internal default, `edg.service.ts`) — not the
    // segmenter's "vertical-clean" default, which only applies through
    // `edgInitInputFor`. `edg-harness.ts`'s `seed()` calls `initialise`
    // directly, so this is the ref a real render actually has to resolve.
    const existingStyle = await ctx.prisma.stylePreset.findFirst({
      where: { workspaceId: null, key: "clean-bold" },
    });
    if (existingStyle === null) {
      const doc = loadSystemStyleMap().get("vertical-clean");
      if (doc === undefined) throw new Error("vertical-clean system style missing");
      await ctx.prisma.stylePreset.create({
        data: {
          id: "01JEXPSTYLEVCLEAN00000000",
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

  const secret = (): string => process.env["INTERNAL_CALLBACK_SECRET"] ?? "";

  interface DecisionBody {
    exportId: string;
    path: "browser" | "cloud";
    reasons: string[];
    watermarked: boolean;
    manifest?: Record<string, unknown>;
  }

  it("issues a watermark-free manifest for a workspace's first (signup-gift) browser export", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "reels",
        outputKind: "video",
        mode: "browser",
        script: "roman",
        capabilities: { codecs: ["avc1.640034"], audioEncoder: true },
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.path).toBe("browser");
    expect(response.body.watermarked).toBe(false);
    expect(response.body.reasons.join(" ")).toMatch(/free clean export/i);
    const manifest = response.body.manifest;
    expect(manifest).toBeDefined();
    expect(manifest?.["watermark"]).toBeNull();

    // The manifest verifies under the API's own key — the same check A19 and
    // apps/render run before drawing a frame (THREAT-MODEL T10).
    const verified = verifyRenderManifest({ manifest, secret: secret() });
    expect(verified.manifest.workspaceId).toBe(ctx.workspaceId);
    expect(verified.manifest.caps).toEqual({
      maxWidth: 1_920,
      maxHeight: 1_920,
      maxDurationMs: 20 * 60_000,
      maxFps: 60,
      allowAlpha: false,
    });

    const exportRow = await ctx.prisma.export.findUniqueOrThrow({
      where: { id: response.body.exportId },
    });
    expect(exportRow.status).toBe("pending_browser");
    expect(exportRow.watermarked).toBe(false);

    const manifestRow = await ctx.prisma.exportManifest.findUniqueOrThrow({
      where: { id: verified.manifest.manifestId },
    });
    expect(manifestRow.consumesSignupGift).toBe(true);
    expect(manifestRow.consumedAt).toBeNull();

    // --- complete it -------------------------------------------------------
    const complete = await call(
      "POST",
      `/exports/manifests/${verified.manifest.manifestId}/complete`,
      {
        token,
        body: { sizeBytes: 512_000, durationMs: 8_000, checksum: "sha256:deadbeef" },
      },
    );
    expect(complete.status).toBe(201);

    const succeeded = await ctx.prisma.export.findUniqueOrThrow({
      where: { id: response.body.exportId },
    });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.sizeBytes).toBe(512_000n);
    expect(succeeded.durationMs).toBe(8_000);
    expect(succeeded.checksum).toBe("sha256:deadbeef");
    expect(succeeded.expiresAt).not.toBeNull();

    const workspace = await ctx.prisma.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
    });
    expect(workspace.signupGiftConsumedAt).not.toBeNull();

    const publishEvents = await ctx.prisma.publishEvent.findMany({
      where: { exportId: response.body.exportId },
    });
    expect(publishEvents).toHaveLength(1);
    expect(publishEvents[0]?.surface).toBe("web");

    // --- replay is refused ---------------------------------------------------
    const replay = await call(
      "POST",
      `/exports/manifests/${verified.manifest.manifestId}/complete`,
      {
        token,
        body: { sizeBytes: 512_000, durationMs: 8_000, checksum: "sha256:deadbeef" },
      },
    );
    expect(replay.status).toBe(409);
    expect((replay.body as { error: { code: string } }).error.code).toBe(
      "export/manifest_already_consumed",
    );

    // --- download is refused: a browser export never leaves the browser ------
    const download = await call("GET", `/exports/${response.body.exportId}/download`, { token });
    expect(download.status).toBe(409);
    expect((download.body as { error: { code: string } }).error.code).toBe("export/not_ready");

    // --- it shows up in the list ---------------------------------------------
    const list = await call<{ items: { id: string; status: string }[] }>(
      "GET",
      `/projects/${seeded.projectId}/exports`,
      { token },
    );
    expect(list.status).toBe(200);
    expect(
      list.body.items.some(
        (item) => item.id === response.body.exportId && item.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("watermarks a second browser export once the signup gift is already spent", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "reels",
        outputKind: "video",
        mode: "browser",
        script: "roman",
        capabilities: { codecs: ["avc1.640034"], audioEncoder: true },
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.watermarked).toBe(true);
    expect(response.body.manifest?.["watermark"]).toEqual({
      assetId: "aksharo-watermark",
      position: "bottom-right",
      opacity: 0.85,
    });
  });

  it("refuses an expired manifest with 410 export/manifest_expired", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "reels",
        outputKind: "video",
        mode: "browser",
        script: "roman",
        capabilities: { codecs: ["avc1.640034"], audioEncoder: true },
      },
    });
    const manifestId = response.body.manifest?.["manifestId"] as string;

    await ctx.prisma.exportManifest.update({
      where: { id: manifestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const complete = await call("POST", `/exports/manifests/${manifestId}/complete`, {
      token,
      body: { sizeBytes: 1_000, durationMs: 1_000, checksum: "x" },
    });
    expect(complete.status).toBe(410);
    expect((complete.body as { error: { code: string } }).error.code).toBe(
      "export/manifest_expired",
    );
  });

  it("refuses a 4K request on the Free plan before ever choosing a path", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "youtube-4k",
        outputKind: "video",
        mode: "auto",
        script: "roman",
      },
    });
    expect(response.status).toBe(402);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "entitlement/upgrade_required",
    );
  });

  it("refuses an explicit browser request for an alpha (cloud-only) output", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "reels",
        outputKind: "alpha",
        mode: "browser",
        script: "roman",
      },
    });
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "export/unsupported_in_browser",
    );
  });

  it("srt/vtt/txt subtitle requests are free and go straight to the cloud path", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call<DecisionBody>("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: {
        kind: "subtitle",
        subtitle: { formats: ["srt", "vtt"], scripts: ["roman"] },
        mode: "auto",
      },
    });
    expect(response.status).toBe(201);
    expect(response.body.path).toBe("cloud");
    expect(response.body.watermarked).toBe(false);

    const job = await ctx.prisma.job.findFirst({
      where: { projectId: seeded.projectId, type: "render.subtitle" },
    });
    expect(job).not.toBeNull();
    expect(job?.creditsChargedTenths).toBe(0);
  });

  it("refuses the MD subtitle format on the Free plan", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const response = await call("POST", `/projects/${seeded.projectId}/exports`, {
      token,
      body: { kind: "subtitle", subtitle: { formats: ["md"], scripts: ["roman"] }, mode: "auto" },
    });
    expect(response.status).toBe(402);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "export/format_upgrade_required",
    );
  });
});

describe.skipIf(!available)("exports — A21b: source URLs alongside the manifest", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error(`exports A21b suite could not start: ${edgSkipReason}`);
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
        id: "01JEXPFREEPLANA21B000000",
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
          id: "01JEXPSTYLEVCLEANA21B0000",
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
  ): Promise<{ status: number; body: T }> {
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

  interface DecisionBody {
    exportId: string;
    path: "browser" | "cloud";
    manifest?: Record<string, unknown>;
    sources?: { rawUrl: string; proxyUrl?: string; watermarkUrl?: string };
  }

  /** `X-Amz-Expires` on a presigned S3 URL, whole seconds. */
  function presignedTtlSeconds(url: string): number {
    return Number(new URL(url).searchParams.get("X-Amz-Expires"));
  }

  async function requestBrowserExport(projectId: string, token: string): Promise<DecisionBody> {
    const response = await call<DecisionBody>("POST", `/projects/${projectId}/exports`, {
      token,
      body: {
        kind: "video",
        preset: "reels",
        outputKind: "video",
        mode: "browser",
        script: "roman",
        capabilities: { codecs: ["avc1.640034"], audioEncoder: true },
      },
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  it("issues sources alongside the manifest, never inside it, with a 15-minute TTL", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");

    const body = await requestBrowserExport(seeded.projectId, token);

    expect(body.sources).toBeDefined();
    expect(body.manifest?.["sources"]).toBeUndefined();
    expect(body.sources?.rawUrl).toBeDefined();
    expect(new URL(body.sources?.rawUrl ?? "").pathname).toContain(seeded.mediaId);
    expect(presignedTtlSeconds(body.sources?.rawUrl ?? "")).toBe(900);

    // `edg-harness.ts`'s `seed()` never sets a proxy key.
    expect(body.sources?.proxyUrl).toBeUndefined();

    // Free plan, first export in a fresh workspace -> the signup gift clears
    // the watermark, so there is no watermark URL to issue either.
    expect(body.manifest?.["watermark"]).toBeNull();
    expect(body.sources?.watermarkUrl).toBeUndefined();
  });

  it("issues a watermarkUrl once the export is watermarked", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");
    // Spend the workspace's signup gift on a first export (only completing it
    // actually consumes the gift), so the second one is watermarked.
    const first = await requestBrowserExport(seeded.projectId, token);
    const firstManifestId = first.manifest?.["manifestId"] as string;
    const completed = await call("POST", `/exports/manifests/${firstManifestId}/complete`, {
      token,
      body: { sizeBytes: 1_000, durationMs: 1_000, checksum: "x" },
    });
    expect(completed.status).toBe(201);

    const body = await requestBrowserExport(seeded.projectId, token);
    expect(body.manifest?.["watermark"]).not.toBeNull();
    expect(body.sources?.watermarkUrl).toBeDefined();
    expect(new URL(body.sources?.watermarkUrl ?? "").pathname).toContain(
      "/brand/aksharo-watermark.png",
    );
    expect(presignedTtlSeconds(body.sources?.watermarkUrl ?? "")).toBe(900);
  });

  it("GET /exports/manifests/{id}/sources refreshes a fresh set for the owning workspace", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");
    const body = await requestBrowserExport(seeded.projectId, token);
    const manifestId = body.manifest?.["manifestId"] as string;

    const refreshed = await call<{ rawUrl: string }>(
      "GET",
      `/exports/manifests/${manifestId}/sources`,
      { token },
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.rawUrl).toBeDefined();
    expect(new URL(refreshed.body.rawUrl).pathname).toContain(seeded.mediaId);
  });

  it("refuses a refresh from another workspace with 404 — the same ownership check as complete", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");
    const body = await requestBrowserExport(seeded.projectId, token);
    const manifestId = body.manifest?.["manifestId"] as string;

    const otherToken = ctx.token("editor", ctx.otherWorkspaceId);
    const refreshed = await call("GET", `/exports/manifests/${manifestId}/sources`, {
      token: otherToken,
    });
    expect(refreshed.status).toBe(404);
    expect((refreshed.body as { error: { code: string } }).error.code).toBe(
      "export/manifest_not_found",
    );
  });

  it("refuses a refresh of an expired manifest with 410", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");
    const body = await requestBrowserExport(seeded.projectId, token);
    const manifestId = body.manifest?.["manifestId"] as string;

    await ctx.prisma.exportManifest.update({
      where: { id: manifestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const refreshed = await call("GET", `/exports/manifests/${manifestId}/sources`, { token });
    expect(refreshed.status).toBe(410);
    expect((refreshed.body as { error: { code: string } }).error.code).toBe(
      "export/manifest_expired",
    );
  });

  it("refuses a refresh once the manifest has already been consumed", async () => {
    const seeded = await ctx.seed({ words: 20, chunkSize: 20 });
    const token = ctx.token("editor");
    const body = await requestBrowserExport(seeded.projectId, token);
    const manifestId = body.manifest?.["manifestId"] as string;

    const complete = await call("POST", `/exports/manifests/${manifestId}/complete`, {
      token,
      body: { sizeBytes: 1_000, durationMs: 1_000, checksum: "x" },
    });
    expect(complete.status).toBe(201);

    const refreshed = await call("GET", `/exports/manifests/${manifestId}/sources`, { token });
    expect(refreshed.status).toBe(409);
    expect((refreshed.body as { error: { code: string } }).error.code).toBe(
      "export/manifest_already_consumed",
    );
  });

  it("refuses a refresh for an unknown manifest id with 404", async () => {
    const token = ctx.token("editor");
    const refreshed = await call("GET", "/exports/manifests/01JUNKNOWNMANIFEST0000000/sources", {
      token,
    });
    expect(refreshed.status).toBe(404);
  });
});
