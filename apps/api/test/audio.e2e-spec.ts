/**
 * The audio-clean surface end to end, against a real PostgreSQL and a real
 * Redis (B10, wired by B10b).
 *
 * ```
 * POST /projects/{id}/audio/clean         → quote, hold, ai.clean enqueued, audio_cleans row "queued"
 *   worker → POST /internal/jobs/{id}/complete (signed)
 * GET  /projects/{id}/audio/cleans        → "succeeded", metrics, signed cleanedAudioUrl
 * SetAudio {clean: {enabled: true, cleanId}} → EdgHot.audio.clean (CONTRACTS §2, B10b's first-class field)
 * POST /projects/{id}/exports (browser)   → sources.cleanedAudioUrl and manifest.audio carry the clean
 * ```
 *
 * Needs Postgres and Redis, exactly as `edg.e2e-spec.ts`/`exports.e2e-spec.ts`
 * do, and skips loudly without either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@montaj/edg";

import { isDatabaseAvailable, skipReason } from "./db-harness.js";
import { createEdgTestContext, edgSkipReason, type EdgTestContext } from "./edg-harness.js";
import { PLAN_SEEDS } from "../prisma/seed-data.js";
import { internalSignatureHeaders } from "../src/internal/internal-signature.js";

const available = isDatabaseAvailable();
if (!available) console.warn(`[audio.e2e] skipped: ${skipReason}`);

/**
 * Every id column this suite writes literally (`Char(26)`) must be exactly 26
 * characters — a short literal gets silently space-padded by Postgres, and a
 * raw-SQL comparison elsewhere (the credits ledger's atomic reserve) then
 * fails to match it against itself (`bpchar` vs `text` comparison keeps the
 * padding); this is `transcripts-scripts.e2e-spec.ts`'s own `id()` helper.
 */
const id = (kind: string): string => `01JAUD${kind}`.padEnd(26, "0").slice(0, 26);

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

describe.skipIf(!available)("audio — clean, apply, export", () => {
  let ctx: EdgTestContext;
  let base: string;

  beforeAll(async () => {
    const created = await createEdgTestContext();
    if (created === null) throw new Error(`audio suite could not start: ${edgSkipReason}`);
    ctx = created;
    base = `http://127.0.0.1:${String(ctx.port)}`;

    // `audioClean` is gated at "creator" and above (`packages/config/src/credits.ts`,
    // `AudioController`'s own doc comment) — the harness's tenant carries no
    // plan by default, so a subscription has to exist for the guard to pass,
    // exactly as `passes.e2e-spec.ts` sets one up for its own gated routes.
    const creator = PLAN_SEEDS.find((plan) => plan.key === "creator");
    if (creator === undefined) throw new Error("creator plan seed missing");
    const plan = await ctx.prisma.plan.upsert({
      where: { key: "creator" },
      update: {
        entitlements: creator.entitlements,
        creditsPerMonthTenths: creator.creditsPerMonthTenths,
      },
      create: {
        id: id("CREATORPLAN"),
        key: "creator",
        name: creator.name,
        prices: creator.prices,
        creditsPerMonthTenths: creator.creditsPerMonthTenths,
        entitlements: creator.entitlements,
      },
    });
    await ctx.prisma.subscription.create({
      data: {
        id: id("CREATORSUBS"),
        workspaceId: ctx.workspaceId,
        planId: plan.id,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    // B02's real `LedgerCreditsFacade` (CREDITS_FACADE) needs an account with a
    // funded lot to reserve `audioClean`'s 1 credit/media-minute against — a
    // bare `subscriptions` row (what the checkout flow this suite does not run
    // would eventually produce) grants nothing on its own
    // (`transcripts-scripts.e2e-spec.ts`'s own comment on the same point).
    const account = await ctx.prisma.creditAccount.create({
      data: { id: id("CREATORACCT"), workspaceId: ctx.workspaceId, balanceTenths: 3_000 },
    });
    await ctx.prisma.creditLot.create({
      data: {
        id: id("CREATORLOT"),
        accountId: account.id,
        source: "grant",
        grantedTenths: 3_000,
        remainingTenths: 3_000,
      },
    });
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

  async function completeCleanJob(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<HttpResult> {
    const job = await ctx.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const attemptId = job.attemptId ?? "";
    const body = { status: "succeeded", result };
    const raw = JSON.stringify(body);
    const response = await fetch(`${base}/internal/jobs/${jobId}/complete`, {
      method: "POST",
      headers: internalSignatureHeaders({ secret: secret(), attemptId, body: raw }),
      body: raw,
    });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as unknown };
  }

  interface CleanAccepted {
    jobId: string;
    cleanId: string;
    status: string;
    deduplicated: boolean;
    quote: { tenths: number; credits: string; durationMs: number };
  }

  interface CleanListBody {
    cleans: {
      id: string;
      status: string;
      metrics?: Record<string, unknown>;
      cleanedAudioUrl?: string;
      previewOriginalUrl?: string;
      previewCleanedUrl?: string;
    }[];
  }

  it("cleans audio, applies it via SetAudio, and carries cleanedAudioUrl into a browser export", async () => {
    const project = await ctx.seed({ words: 30, chunkSize: 30 });
    const token = ctx.token("editor");

    // `AudioService.media()` requires a 48 kHz derived track before it will
    // quote a clean; `edg-harness.ts`'s `seed()` does not set one (its own
    // suite has no use for it), so this suite sets it directly.
    await ctx.prisma.mediaAsset.update({
      where: { id: project.mediaId },
      data: {
        audio48kKey: `ws/${ctx.workspaceId}/p/${project.projectId}/media/${project.mediaId}/audio48k.wav`,
      },
    });

    // --- 1. start the clean --------------------------------------------------
    const started = await call<CleanAccepted>(
      "POST",
      `/projects/${project.projectId}/audio/clean`,
      { token, body: { strength: "medium", target: "social" } },
    );
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("queued");
    expect(started.body.deduplicated).toBe(false);

    const { jobId, cleanId } = started.body;

    const queuedRow = await ctx.prisma.audioClean.findUniqueOrThrow({ where: { id: cleanId } });
    expect(queuedRow.status).toBe("queued");
    expect(queuedRow.jobId).toBe(jobId);

    // --- 2. the worker fakes a completion -------------------------------------
    const storageKeys = {
      cleanedAudioUrl: `ws/${ctx.workspaceId}/p/${project.projectId}/clean/${cleanId}/clean.wav`,
      previewOriginalUrl: `ws/${ctx.workspaceId}/p/${project.projectId}/clean/${cleanId}/preview-original.mp3`,
      previewCleanedUrl: `ws/${ctx.workspaceId}/p/${project.projectId}/clean/${cleanId}/preview-cleaned.mp3`,
    };
    const completion = await completeCleanJob(jobId, {
      cleanId,
      mediaId: project.mediaId,
      strength: "medium",
      target: "social",
      storageKeys,
      metrics: { inputLufs: -12, outputLufs: -16, snrGainDb: 8, truePeakDbtp: -1.5 },
    });
    expect(completion.status).toBe(200);

    // --- 3. read it back: succeeded, metrics, signed URLs ---------------------
    const listed = await call<CleanListBody>("GET", `/projects/${project.projectId}/audio/cleans`, {
      token,
    });
    expect(listed.status).toBe(200);
    const row = listed.body.cleans.find((c) => c.id === cleanId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("succeeded");
    expect(row?.metrics).toMatchObject({ inputLufs: -12, outputLufs: -16, snrGainDb: 8 });
    expect(row?.cleanedAudioUrl).toBeDefined();
    expect(row?.cleanedAudioUrl).toMatch(/^https?:\/\//);
    expect(row?.previewOriginalUrl).toBeDefined();
    expect(row?.previewCleanedUrl).toBeDefined();

    const succeededRow = await ctx.prisma.audioClean.findUniqueOrThrow({ where: { id: cleanId } });
    expect(succeededRow.status).toBe("succeeded");
    expect(succeededRow.completedAt).not.toBeNull();

    // --- 4. apply it: SetAudio.clean.cleanId (CONTRACTS §2, B10b) -------------
    const opId = newId();
    const setAudio = await call<{ revision: number; applied: string[]; rejected: unknown[] }>(
      "POST",
      `/projects/${project.projectId}/edg/ops`,
      {
        token,
        body: {
          baseRevision: project.revision,
          ops: [{ opId, type: "SetAudio", clean: { enabled: true, cleanId } }],
          clientOpIds: [opId],
        },
      },
    );
    expect(setAudio.status).toBe(200);
    expect(setAudio.body.applied).toEqual([opId]);
    expect(setAudio.body.rejected).toEqual([]);

    const doc = await call<{ hot: { audio?: { clean?: { enabled: boolean; cleanId: string } } } }>(
      "GET",
      `/projects/${project.projectId}/edg`,
      { token },
    );
    expect(doc.status).toBe(200);
    expect(doc.body.hot.audio?.clean).toEqual({ enabled: true, cleanId });

    // --- 5. export: the manifest and sources carry the cleaned track ----------
    const exported = await call<{
      manifest: { audio?: { strategy: string; cleanId?: string; cleanKey?: string } };
      sources?: { cleanedAudioUrl?: string };
    }>("POST", `/projects/${project.projectId}/exports`, {
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
    expect(exported.status).toBe(201);
    expect(exported.body.manifest.audio?.strategy).toBe("replace");
    expect(exported.body.manifest.audio?.cleanId).toBe(cleanId);
    expect(exported.body.manifest.audio?.cleanKey).toBe(storageKeys.cleanedAudioUrl);
    expect(exported.body.sources?.cleanedAudioUrl).toBeDefined();
    expect(exported.body.sources?.cleanedAudioUrl).toMatch(/^https?:\/\//);
  });

  it("refuses a clean request from a workspace with no media", async () => {
    const project = await ctx.prisma.project.create({
      data: {
        id: id("NOMEDIAPROJECT"),
        workspaceId: ctx.workspaceId,
        title: "no media",
        aspect: "r9x16",
      },
    });
    const response = await call("POST", `/projects/${project.id}/audio/clean`, {
      token: ctx.token("editor"),
      body: { strength: "medium", target: "social" },
    });
    expect(response.status).toBe(409);
  });
});
