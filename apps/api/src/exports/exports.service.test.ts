import { describe, expect, it, vi } from "vitest";

import type { EdgProjection } from "@montaj/edg/schemas";

import { ExportsService, cuesOf } from "./exports.service.js";

import type { BrandAssetsService } from "./brand-assets.service.js";
import type { BrowserManifestDailyCap } from "./daily-cap.js";
import type { DefaultWatermarkService } from "./default-watermark.service.js";
import type { RequestExportInput } from "./exports.service.js";
import type { AudioAssetsRepository } from "../audio-assets/index.js";
import type { BrandKitService } from "../brand-kit/brand-kit.service.js";
import type { ManifestSignerService } from "../common/crypto/manifest-signer.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { EdgRepository } from "../edg/index.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { EntitlementService } from "../workspaces/entitlement.service.js";
import type { EventEmitter2 } from "@nestjs/event-emitter";

/**
 * `POST /projects/{id}/exports`, cloud branch (S05 step 2).
 *
 * The one thing this file exists to hold still: a cloud export is an `exports`
 * row from the moment it is requested. Before S05 the cloud branch wrote only a
 * manifest and a job, so the id the client was handed named nothing until the
 * completion handler invented a row for it — and a render that failed never got
 * one at all.
 *
 * Everything pure runs for real here (`decideExport`, `buildRenderManifest`,
 * `buildRenderProjection`); only the injected collaborators are fakes, in the
 * hand-rolled style of `render-completion.handler.test.ts` — this package has no
 * module mocking anywhere in `apps/api`.
 */

const WORKSPACE_ID = "01JA20WKSPACE0000000000000";
const PROJECT_ID = "01JA20PRJECT00000000000000";
const EDG_ID = "01JA20EDG00000000000000000";
const MEDIA_ID = "01JA20MEDA0000000000000000";
const TRANSCRIPT_ID = "01JA20TRANSCRPT00000000000";
const JOB_ID = "01JA20J0B00000000000000001";

const TRACK = "01JA20TRACK000000000000000".replace(/[IL]/g, "0");
const TRACK_KEY = `ws/${WORKSPACE_ID}/brand/${TRACK}.mp3`;

/** An accepted bed of the workspace's own music over the whole clip (2026-10-04). */
function workspaceBedPass(): Record<string, unknown> {
  const payload = {
    assetId: TRACK,
    packId: "workspace",
    startMs: 0,
    durationMs: 30_000,
    gainDb: -20,
    loopPolicy: "loop",
    bedDuck: { depthDb: -10, attackMs: 250, releaseMs: 400 },
    licenceSnapshot: { source: "workspace" },
    mood: [],
  };
  return {
    passId: "01JA20PASS0000000000000000",
    type: "music",
    engine: "brand-music@1",
    params: {},
    status: "ready",
    items: [
      {
        itemId: "01JA20BED00000000000000000",
        passId: "01JA20PASS0000000000000000",
        kind: "music",
        startMs: 0,
        endMs: 30_000,
        state: "accepted",
        payload,
      },
    ],
  };
}

function edgProjection(): EdgProjection {
  return {
    meta: { edgId: EDG_ID, projectId: PROJECT_ID, revision: 3, schemaVersion: 2 },
    media: [],
    transcript: {
      transcriptId: TRANSCRIPT_ID,
      revision: 1,
      language: "hi-Latn",
      scripts: ["roman"],
      speakers: [],
    },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "vertical-clean" },
    segments: [],
    passes: [],
  } as unknown as EdgProjection;
}

function harness(options: { passes?: unknown[] } = {}) {
  const create = vi.fn(async (args: unknown) => args);
  const prisma = {
    project: {
      findFirst: vi.fn(async () => ({
        id: PROJECT_ID,
        aspect: "r9x16",
        edgDocument: { id: EDG_ID },
      })),
    },
    mediaAsset: {
      findFirst: vi.fn(async () => ({
        id: MEDIA_ID,
        bucket: "s3",
        storageKey: "ws/" + WORKSPACE_ID + "/p/" + PROJECT_ID + "/media/" + MEDIA_ID + "/raw.mp4",
        durationMs: 30_000,
        width: 1080,
        height: 1920,
        fps: 30,
        hdr: false,
      })),
    },
    workspace: { findUniqueOrThrow: vi.fn(async () => ({ signupGiftConsumedAt: null })) },
    stylePreset: { findMany: vi.fn(async () => []) },
    exportManifest: { create: vi.fn(async () => ({})) },
    export: { create },
  } as unknown as PrismaService;

  const edgRepository = {
    projectionOf: vi.fn(async () => ({ ...edgProjection(), passes: options.passes ?? [] })),
    loadChunks: vi.fn(async () => []),
  } as unknown as EdgRepository;

  const entitlements = {
    forWorkspace: vi.fn(async () => ({
      planKey: "free",
      entitlements: { watermark: "after_first_clean_export", maxExportResolution: "1080p" },
    })),
  } as unknown as EntitlementService;

  const enqueue = vi.fn(async () => ({
    job: { id: JOB_ID, status: "queued" },
    deduplicated: false,
  }));
  const jobs = { enqueue } as unknown as JobsService;

  const signer = {
    sign: (manifest: Record<string, unknown>) => ({ ...manifest, sig: "test-signature" }),
  } as unknown as ManifestSignerService;

  const brandKits = {
    availableImages: vi.fn(async () => new Set<string>()),
    musicStorageKeys: vi.fn(
      async (_workspaceId: string, ids: readonly string[]) =>
        new Map(ids.filter((id) => id === TRACK).map((id) => [id, TRACK_KEY])),
    ),
  };
  const service = new ExportsService(
    prisma,
    edgRepository,
    entitlements,
    jobs,
    signer,
    { resolveForWatermark: vi.fn() } as unknown as BrandAssetsService,
    { recordAndCheck: vi.fn() } as unknown as BrowserManifestDailyCap,
    { ensure: vi.fn(async () => undefined) } as unknown as DefaultWatermarkService,
    {} as unknown as ObjectStore,
    {} as unknown as ObjectStore,
    { isAvailable: vi.fn(async () => false), consume: vi.fn(async () => undefined) },
    { emit: vi.fn() } as unknown as EventEmitter2,
    { findStorageKeysByIds: vi.fn(async () => new Map()) } as unknown as AudioAssetsRepository,
    brandKits as unknown as BrandKitService,
  );

  return { service, create, enqueue, brandKits };
}

function input(overrides: Partial<RequestExportInput> = {}): RequestExportInput {
  return {
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    userId: null,
    kind: "video",
    outputKind: "video",
    preset: "reels",
    script: "roman",
    mode: "cloud",
    dropFillers: false,
    options: { watermarkPosition: "bottom-right", watermarkOpacity: 1 },
    ...overrides,
  } as RequestExportInput;
}

/** The `data` of the single `prisma.export.create` the cloud branch makes. */
function createdRow(create: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(create).toHaveBeenCalledTimes(1);
  return (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
}

describe("ExportsService.requestExport — the cloud branch (S05-2)", () => {
  it("writes the export row at POST time, rendering, under the id it returns", async () => {
    const { service, create, enqueue } = harness();

    const result = await service.requestExport(input());
    expect(result.path).toBe("cloud");

    const row = createdRow(create);
    expect(row["status"]).toBe("rendering");
    // The id the client is handed IS the row — no second id, no pin needed.
    expect(row["id"]).toBe(result.exportId);
    // And the row names the job that will finish it.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(row["jobId"]).toBe(JOB_ID);
    expect(result.job?.jobId).toBe(JOB_ID);

    expect(row).toMatchObject({
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      kind: "mp4",
      preset: "reels",
      bucket: "r2",
      resolution: "1080x1920",
    });
  });

  /**
   * `subtitle.formats` is a non-empty array (`SubtitleOptionsRequest`,
   * `exports.dto.ts:38`). The row takes the FIRST requested format, because that
   * is the sidecar `render-completion.handler.ts` writes under this same id.
   */
  it("takes a subtitle export's kind from the first requested format", async () => {
    const { service, create } = harness();

    await service.requestExport(
      input({ kind: "subtitle", subtitle: { formats: ["vtt", "srt"], scripts: ["roman"] } }),
    );

    expect(createdRow(create)).toMatchObject({ kind: "vtt", status: "rendering" });
  });
});

describe("ExportsService.requestExport — a workspace's own music (2026-10-04)", () => {
  it("mixes the kit's track in, from the workspace's own brand assets", async () => {
    const { service, enqueue, brandKits } = harness({ passes: [workspaceBedPass()] });

    await service.requestExport(input());

    expect(brandKits.musicStorageKeys).toHaveBeenCalledWith(WORKSPACE_ID, [TRACK]);
    const params = (enqueue.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0]
      .params;
    const manifest = params["manifest"] as {
      timemap: { audio?: { music?: Record<string, unknown>[] } };
    };
    expect(manifest.timemap.audio?.music).toEqual([
      expect.objectContaining({
        assetId: TRACK,
        packId: "workspace",
        storageKey: TRACK_KEY,
        loopPolicy: "loop",
        gainDb: -20,
        bedDuck: { depthDb: -10, attackMs: 250, releaseMs: 400 },
      }),
    ]);
  });

  it("leaves out a bed whose track the workspace no longer keeps", async () => {
    const { service, enqueue, brandKits } = harness({ passes: [workspaceBedPass()] });
    brandKits.musicStorageKeys.mockResolvedValueOnce(new Map());

    await service.requestExport(input());

    const params = (enqueue.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0]
      .params;
    const manifest = params["manifest"] as { timemap: { audio?: { music?: unknown[] } } };
    expect(manifest.timemap.audio?.music ?? []).toEqual([]);
  });

  it("names every sound a manifest mixes in, for the browser to fetch", () => {
    expect(
      cuesOf({
        timemap: {
          audio: {
            sfx: [{ assetId: "a", storageKey: "packs/p/a.wav" }],
            music: [{ assetId: TRACK, storageKey: TRACK_KEY }],
          },
        },
      }),
    ).toEqual([
      { assetId: "a", storageKey: "packs/p/a.wav" },
      { assetId: TRACK, storageKey: TRACK_KEY },
    ]);
    expect(cuesOf({})).toEqual([]);
  });
});
