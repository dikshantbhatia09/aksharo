import { describe, expect, it, vi } from "vitest";

import { FacesTrigger, MediaFacesCompletionHandler, facesJobKey } from "./faces.js";
import { JobCompletionRegistry } from "../jobs/completion-handlers.js";

import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { JobCompletionContext } from "../jobs/completion-handlers.js";
import type { JobsService } from "../jobs/jobs.service.js";

const WS = "01M1KFX35NJRD5N58H0J6YGAPC";
const PROJECT = "01M2WVJVPGWVCX7WV5FYSZ06HY";
const MEDIA = "01M2WVJVQ29X04CYV3EB7T3F09";
const FACES_KEY = `ws/${WS}/p/${PROJECT}/media/${MEDIA}/faces.json`;

function readyVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA,
    projectId: PROJECT,
    status: "ready",
    width: 720,
    proxyKey: "proxy540.mp4",
    facesKey: null,
    derivedPurgedAt: null,
    project: { workspaceId: WS, deletedAt: null },
    ...overrides,
  };
}

function trigger(
  media: unknown,
  enqueue = vi.fn(async () => ({ job: { id: "job-1" } })),
  priorJobs = 0,
) {
  const prisma = {
    mediaAsset: { findUnique: vi.fn(async () => media) },
    job: { count: vi.fn(async () => priorJobs) },
  };
  return {
    enqueue,
    trigger: new FacesTrigger(
      prisma as unknown as PrismaService,
      { enqueue } as unknown as JobsService,
    ),
  };
}

describe("FacesTrigger", () => {
  it("queues a free, uncapped ai.faces for a ready video with no face track", async () => {
    const { trigger: t, enqueue } = trigger(readyVideo());
    await expect(t.maybeEnqueue(MEDIA)).resolves.toEqual({ jobId: "job-1" });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ai.faces",
        workspaceId: WS,
        projectId: PROJECT,
        params: { mediaId: MEDIA, projectId: PROJECT },
        jobKey: facesJobKey(MEDIA),
        worstCaseTenths: 0,
        skipAdmission: true,
      }),
    );
  });

  it.each([
    ["audio-only media", { width: null }],
    ["media not ready", { status: "probing" }],
    ["media that already has a face track", { facesKey: FACES_KEY }],
    ["purged media", { derivedPurgedAt: new Date() }],
    ["a deleted project", { project: { workspaceId: WS, deletedAt: new Date() } }],
  ])("skips %s", async (_label, overrides) => {
    const { trigger: t, enqueue } = trigger(readyVideo(overrides));
    await expect(t.maybeEnqueue(MEDIA)).resolves.toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("on the lazy path, tries a media only once, whatever became of that job", async () => {
    const tried = trigger(readyVideo(), undefined, 1);
    await expect(tried.trigger.maybeEnqueue(MEDIA, { onlyIfNeverTried: true })).resolves.toBeUndefined();
    expect(tried.enqueue).not.toHaveBeenCalled();

    const fresh = trigger(readyVideo(), undefined, 0);
    await expect(fresh.trigger.maybeEnqueue(MEDIA, { onlyIfNeverTried: true })).resolves.toEqual({
      jobId: "job-1",
    });
  });

  it("never throws when the queue refuses", async () => {
    const { trigger: t } = trigger(
      readyVideo(),
      vi.fn(async () => {
        throw new Error("redis down");
      }),
    );
    await expect(t.maybeEnqueue(MEDIA)).resolves.toBeUndefined();
  });
});

describe("MediaFacesCompletionHandler", () => {
  function handler() {
    const update = vi.fn(async () => ({}));
    const prisma = {
      mediaAsset: {
        findUnique: vi.fn(async () => ({
          id: MEDIA,
          projectId: PROJECT,
          project: { workspaceId: WS },
        })),
        update,
      },
    };
    return {
      update,
      handler: new MediaFacesCompletionHandler(
        prisma as unknown as PrismaService,
        new JobCompletionRegistry(),
      ),
    };
  }
  const context = (facesKey: string) =>
    ({
      job: { params: { mediaId: MEDIA } },
      result: { facesKey },
    }) as unknown as JobCompletionContext;

  it("records the media's own faces.json and charges nothing", async () => {
    const { handler: h, update } = handler();
    await expect(h.handle(context(FACES_KEY))).resolves.toMatchObject({ actualTenths: 0 });
    expect(update).toHaveBeenCalledWith({ where: { id: MEDIA }, data: { facesKey: FACES_KEY } });
  });

  it("refuses a key outside the media's own prefix", async () => {
    const { handler: h, update } = handler();
    const foreign = `ws/${WS}/p/${PROJECT}/media/01M2WVJVQ29X04CYV3EB7T3F0A/faces.json`;
    await expect(h.handle(context(foreign))).rejects.toThrow("outside this media's own prefix");
    expect(update).not.toHaveBeenCalled();
  });
});
