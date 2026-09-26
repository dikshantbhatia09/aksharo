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
  };
  const edg = {
    projectionOf: vi.fn(async () => ({
      meta: { edgId: "EDG1", projectId: PROJECT, revision: 1, schemaVersion: 2 },
      media: [],
      transcript: { transcriptId: "TR1", revision: 1, language: "en", scripts: ["roman"] },
      canvas: { width: 1080, height: 1920 },
      styles: { defaultStyleId: "punch-pop" },
      segments: [],
    })),
    loadChunks: vi.fn(async () => []),
  };
  const derived = {
    presignGet: vi.fn(
      async (key: string, _ttlSeconds: number) => `https://cdn.example.test/${key}`,
    ),
  };
  const faces = { maybeEnqueue: vi.fn(async () => undefined) };
  return { prisma, edg, derived, faces };
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
    );
  }

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
