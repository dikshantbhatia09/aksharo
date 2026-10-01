import { describe, expect, it, vi } from "vitest";

import { MEDIA_ERRORS, PROJECT_ERRORS } from "./projects.constants.js";
import {
  buildRenderPreview,
  RenderPreviewService,
  WORKSPACE_PREVIEW_URL_TTL_SECONDS,
} from "./render-preview.js";
import { DOWNLOAD_URL_TTL_SECONDS } from "../common/storage/index.js";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCPR0JECT000000000000000";
const PROXY_KEY = `ws/${WS}/p/${PROJECT}/media/M1/proxy540.mp4`;
const FACES_KEY = `ws/${WS}/p/${PROJECT}/media/M1/faces.json`;

function deps(
  options: {
    media?: Record<string, unknown> | null;
    document?: boolean;
    project?: Record<string, unknown> | null;
    overlays?: readonly Record<string, unknown>[];
    keptLogos?: readonly string[];
    keptPictures?: readonly string[];
    defaultStyleId?: string;
    presets?: readonly { key: string; workspaceId: string | null; doc: unknown }[];
  } = {},
) {
  const media =
    options.media === undefined
      ? { id: "M1", proxyKey: PROXY_KEY, facesKey: FACES_KEY, durationMs: 31_000 }
      : options.media;
  const prisma = {
    project: {
      findFirst: vi.fn(async () =>
        options.project === undefined ? { id: PROJECT, aspect: "r9x16" } : options.project,
      ),
    },
    mediaAsset: { findFirst: vi.fn(async () => media) },
    edgDocument: {
      findUnique: vi.fn(async () => (options.document === false ? null : { id: "EDG1" })),
    },
    // Rows `resolveStyleSnapshot` reads; none means the system catalogue answers.
    stylePreset: { findMany: vi.fn(async () => options.presets ?? []) },
  };
  const edg = {
    projectionOf: vi.fn(async () => ({
      meta: { edgId: "EDG1", projectId: PROJECT, revision: 1, schemaVersion: 2 },
      media: [],
      transcript: { transcriptId: "TR1", revision: 1, language: "en", scripts: ["roman"] },
      canvas: { width: 1080, height: 1920 },
      styles: { defaultStyleId: options.defaultStyleId ?? "punch-pop" },
      segments: [],
      ...(options.overlays === undefined ? {} : { overlays: options.overlays }),
    })),
    loadChunks: vi.fn(async () => []),
  };
  const derived = {
    presignGet: vi.fn(
      async (key: string, _ttlSeconds: number) => `https://cdn.example.test/${key}`,
    ),
  };
  const faces = { maybeEnqueue: vi.fn(async () => undefined) };
  const brandKits = {
    imageUrls: vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      Object.fromEntries(
        ids
          .filter((id) => (options.keptLogos ?? []).includes(id))
          .map((id) => [id, `https://cdn.example.test/brand/${id}`]),
      ),
    ),
  };
  const broll = {
    imageUrls: vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      Object.fromEntries(
        ids
          .filter((id) => (options.keptPictures ?? []).includes(id))
          .map((id) => [id, `https://cdn.example.test/broll/${id}`]),
      ),
    ),
  };
  return { prisma, edg, derived, faces, brandKits, broll };
}

/** Every TTL `presignGet` was asked for, by key. */
function ttlsOf(d: ReturnType<typeof deps>): Record<string, unknown> {
  return Object.fromEntries(d.derived.presignGet.mock.calls.map((call) => [call[0], call[1]]));
}

describe("buildRenderPreview", () => {
  it("returns the proxy, the face track and the projection the exporter would draw", async () => {
    const d = deps();
    const preview = await buildRenderPreview(d as never, { id: PROJECT, aspect: "r9x16" });

    expect(preview).toMatchObject({
      proxyUrl: `https://cdn.example.test/${PROXY_KEY}`,
      facesUrl: `https://cdn.example.test/${FACES_KEY}`,
      durationMs: 31_000,
      aspect: "r9x16",
      projection: expect.objectContaining({
        canvas: { width: 1080, height: 1920 },
        styles: { defaultStyleId: "punch-pop" },
        segments: [],
        words: [],
      }),
    });
    expect(d.prisma.mediaAsset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: PROJECT, role: "primary", status: "ready" } }),
    );
  });

  it("signs for the public viewer's five minutes unless told otherwise", async () => {
    const d = deps();
    await buildRenderPreview(d as never, { id: PROJECT, aspect: "r9x16" });
    expect(ttlsOf(d)).toEqual({
      [PROXY_KEY]: DOWNLOAD_URL_TTL_SECONDS,
      [FACES_KEY]: DOWNLOAD_URL_TTL_SECONDS,
    });
  });

  it("leaves out the face track when the video has none yet, and says which video", async () => {
    const onMissingFaces = vi.fn();
    const preview = await buildRenderPreview(
      deps({ media: { id: "M1", proxyKey: PROXY_KEY, facesKey: null, durationMs: 1 } }) as never,
      { id: PROJECT, aspect: "r9x16" },
      { onMissingFaces },
    );
    expect(preview).not.toHaveProperty("facesUrl");
    expect(onMissingFaces).toHaveBeenCalledWith("M1");
  });

  it("has no projection before the project has an editing document", async () => {
    const preview = await buildRenderPreview(deps({ document: false }) as never, {
      id: PROJECT,
      aspect: "r9x16",
    });
    expect(preview?.projection).toBeNull();
  });

  // 2026-10-01: the share viewer drew a saved look in the default style because
  // the browser only knew the system catalogue.
  it("carries the workspace's own look the document uses, keyed and identified by its ref", async () => {
    const d = deps({
      defaultStyleId: "my-look",
      presets: [{ key: "my-look", workspaceId: WS, doc: { id: "stale", name: "Studio yellow" } }],
    });
    const preview = await buildRenderPreview(d as never, {
      id: PROJECT,
      aspect: "r9x16",
      workspaceId: WS,
    });
    expect(d.prisma.stylePreset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: { in: ["my-look"] }, OR: [{ workspaceId: WS }, { workspaceId: null }] },
      }),
    );
    expect(preview?.styles).toEqual({ "my-look": { id: "my-look", name: "Studio yellow" } });
  });

  it("carries a workspace's override of a system key, but never a system row itself", async () => {
    const system = deps({
      presets: [{ key: "punch-pop", workspaceId: null, doc: { id: "punch-pop", name: "Sys" } }],
    });
    const plain = await buildRenderPreview(system as never, {
      id: PROJECT,
      aspect: "r9x16",
      workspaceId: WS,
    });
    expect(plain).not.toHaveProperty("styles");

    const overridden = deps({
      presets: [
        { key: "punch-pop", workspaceId: WS, doc: { id: "punch-pop", name: "Ours" } },
        { key: "punch-pop", workspaceId: null, doc: { id: "punch-pop", name: "Sys" } },
      ],
    });
    const preview = await buildRenderPreview(overridden as never, {
      id: PROJECT,
      aspect: "r9x16",
      workspaceId: WS,
    });
    expect(preview?.styles).toEqual({ "punch-pop": { id: "punch-pop", name: "Ours" } });
  });

  it("looks up no styles without a workspace or without a document", async () => {
    const noWorkspace = deps({ defaultStyleId: "my-look" });
    await buildRenderPreview(noWorkspace as never, { id: PROJECT, aspect: "r9x16" });
    expect(noWorkspace.prisma.stylePreset.findMany).not.toHaveBeenCalled();

    const noDocument = deps({ document: false });
    const preview = await buildRenderPreview(noDocument as never, {
      id: PROJECT,
      aspect: "r9x16",
      workspaceId: WS,
    });
    expect(noDocument.prisma.stylePreset.findMany).not.toHaveBeenCalled();
    expect(preview).not.toHaveProperty("styles");
  });

  it("is null while there is nothing to play", async () => {
    expect(
      await buildRenderPreview(deps({ media: null }) as never, { id: PROJECT, aspect: "r9x16" }),
    ).toBeNull();
    expect(
      await buildRenderPreview(
        deps({ media: { id: "M1", proxyKey: null, facesKey: null, durationMs: 1 } }) as never,
        { id: PROJECT, aspect: "r9x16" },
      ),
    ).toBeNull();
  });
});

describe("RenderPreviewService.forProject", () => {
  function service(d: ReturnType<typeof deps>): RenderPreviewService {
    return new RenderPreviewService(
      d.prisma as never,
      d.edg as never,
      d.derived as never,
      d.faces as never,
      d.brandKits as never,
      d.broll as never,
    );
  }

  it("signs the brand logos the document draws, and leaves out one the workspace no longer keeps (2026-10-02)", async () => {
    const image = (assetId: string) => ({ assetId, format: "png", width: 400, height: 200 });
    const logo = (id: string, assetId: string) => ({
      id,
      kind: "logo",
      startMs: 0,
      endMs: 30_000,
      image: image(assetId),
      corner: "top-right",
      sizePct: 16,
      opacity: 0.9,
      marginPct: 4,
    });
    const KEPT = "01JKEPT0000000000000000000";
    const GONE = "01JG0NE0000000000000000000";
    const d = deps({
      project: { id: PROJECT, aspect: "r9x16", workspaceId: WS },
      overlays: [
        logo("01JL0G0A000000000000000000", KEPT),
        logo("01JL0G0B000000000000000000", GONE),
      ],
      keptLogos: [KEPT],
    });
    const preview = await service(d).forProject(WS, PROJECT);
    expect(d.brandKits.imageUrls).toHaveBeenCalledWith(
      WS,
      [KEPT, GONE],
      WORKSPACE_PREVIEW_URL_TTL_SECONDS,
    );
    expect(preview.images).toEqual({ [KEPT]: `https://cdn.example.test/brand/${KEPT}` });
    expect(preview.projection?.overlays?.map((overlay) => overlay.id)).toEqual([
      "01JL0G0A000000000000000000",
    ]);
  });

  it("signs the B-roll pictures the document's cutaways draw, and leaves out one deleted from the library (2026-10-05)", async () => {
    const cutaway = (id: string, assetId: string) => ({
      id,
      kind: "b-roll",
      startMs: 4_000,
      endMs: 6_500,
      image: { assetId, format: "jpeg", width: 1440, height: 2560 },
      mode: "full",
      motion: "push-in",
    });
    const KEPT = "01JPX0000000000000000000K1";
    const GONE = "01JPX0000000000000000000G1";
    const d = deps({
      project: { id: PROJECT, aspect: "r9x16", workspaceId: WS },
      overlays: [
        cutaway("01JBR0000000000000000000A1", KEPT),
        cutaway("01JBR0000000000000000000B1", GONE),
      ],
      keptPictures: [KEPT],
      // A logo with the same id as the deleted picture never makes its cutaway pass.
      keptLogos: [GONE],
    });
    const preview = await service(d).forProject(WS, PROJECT);
    expect(d.broll.imageUrls).toHaveBeenCalledWith(
      WS,
      [KEPT, GONE],
      WORKSPACE_PREVIEW_URL_TTL_SECONDS,
    );
    expect(d.brandKits.imageUrls).not.toHaveBeenCalled();
    expect(preview.images).toEqual({ [KEPT]: `https://cdn.example.test/broll/${KEPT}` });
    expect(preview.projection?.overlays?.map((overlay) => overlay.id)).toEqual([
      "01JBR0000000000000000000A1",
    ]);
  });

  it("asks for no logo at all for a document that draws none", async () => {
    const d = deps({ project: { id: PROJECT, aspect: "r9x16", workspaceId: WS } });
    const preview = await service(d).forProject(WS, PROJECT);
    expect(d.brandKits.imageUrls).not.toHaveBeenCalled();
    expect(d.broll.imageUrls).not.toHaveBeenCalled();
    expect(preview).not.toHaveProperty("images");
  });

  it("previews a project of the caller's own workspace", async () => {
    const d = deps();
    const preview = await service(d).forProject(WS, PROJECT);
    expect(preview.facesUrl).toBe(`https://cdn.example.test/${FACES_KEY}`);
    expect(d.prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROJECT, workspaceId: WS, deletedAt: null } }),
    );
    expect(d.faces.maybeEnqueue).not.toHaveBeenCalled();
  });

  it("signs for an hour, so a clip opened long after the page loaded still plays", async () => {
    // The run page fetches every clip's preview at once, plays one when it is
    // opened, and pins the URL for most of an hour: five minutes 403'd.
    const d = deps();
    await service(d).forProject(WS, PROJECT);
    expect(WORKSPACE_PREVIEW_URL_TTL_SECONDS).toBe(3_600);
    expect(ttlsOf(d)).toEqual({
      [PROXY_KEY]: WORKSPACE_PREVIEW_URL_TTL_SECONDS,
      [FACES_KEY]: WORKSPACE_PREVIEW_URL_TTL_SECONDS,
    });
  });

  it("queues face detection, once, for a video that has a proxy and no face track", async () => {
    // Clips cut before ai.faces existed: the run page polls this for a track
    // that only opening the editor would otherwise ever ask for.
    const d = deps({ media: { id: "M1", proxyKey: PROXY_KEY, facesKey: null, durationMs: 1 } });
    const preview = await service(d).forProject(WS, PROJECT);
    expect(preview.proxyUrl).toBe(`https://cdn.example.test/${PROXY_KEY}`);
    expect(d.faces.maybeEnqueue).toHaveBeenCalledWith("M1", { onlyIfNeverTried: true });
  });

  it("answers 404 for another workspace's project, or a deleted one", async () => {
    await expect(service(deps({ project: null })).forProject(WS, PROJECT)).rejects.toMatchObject({
      code: PROJECT_ERRORS.notFound,
      httpStatus: 404,
    });
  });

  it("answers 409 until the video has a proxy", async () => {
    await expect(service(deps({ media: null })).forProject(WS, PROJECT)).rejects.toMatchObject({
      code: MEDIA_ERRORS.invalidState,
      httpStatus: 409,
    });
  });
});
