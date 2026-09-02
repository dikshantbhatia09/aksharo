import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEDIA_JOB_KEYS } from "./media.constants.js";
import {
  assertAllowedType,
  assertWithinPlan,
  extensionFor,
  MediaService,
  normaliseMime,
  toMediaView,
} from "./media.service.js";
import { asMock, callArg } from "../../test/mock-args.js";
import { MULTIPART_PART_SIZE_BYTES } from "../common/storage/index.js";
import { mediaLimitsFor } from "../projects/plan-limits.js";

import type { PrismaService } from "../common/index.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { JobsService } from "../jobs/jobs.service.js";
import type { ProjectsService } from "../projects/projects.service.js";
import type { EntitlementService, EntitlementView } from "../workspaces/entitlement.service.js";
import type { MediaAsset, Project } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const MEDIA = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";

function entitlement(values: Record<string, unknown> = {}): EntitlementView {
  return {
    workspaceId: WORKSPACE,
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 300,
    seatsIncluded: 0,
    seatsUsed: 1,
    entitlements: {
      maxFileBytes: 500 * 1024 * 1024,
      maxDurationMs: 1_200_000,
      retentionDays: 7,
      ...values,
    },
    computedAt: new Date().toISOString(),
  };
}

function projectRow(): Project {
  return {
    id: PROJECT,
    workspaceId: WORKSPACE,
    title: "A project",
    folderId: null,
    clientTag: null,
    sourceLanguage: null,
    scripts: [],
    aspect: "r9x16",
    status: "draft",
    thumbnailKey: null,
    durationMs: null,
    lastActivityAt: new Date(),
    retentionUntil: null,
    createdBy: null,
    createdAt: new Date(),
    deletedAt: null,
  } as Project;
}

function mediaRow(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: MEDIA,
    projectId: PROJECT,
    role: "primary",
    bucket: "s3",
    storageKey: `ws/${WORKSPACE}/p/${PROJECT}/media/${MEDIA}/raw.mp4`,
    filename: "clip.mp4",
    uploadId: null,
    partSizeBytes: null,
    sizeBytes: BigInt(1_000),
    contentHash: null,
    mime: "video/mp4",
    durationMs: null,
    fps: null,
    width: null,
    height: null,
    audioChannels: null,
    proxyKey: null,
    audio16kKey: null,
    audio48kKey: null,
    waveformKey: null,
    thumbKeys: [],
    status: "pending",
    needsRealign: false,
    uploadedAt: null,
    rawPurgeAt: null,
    derivedPurgeAt: null,
    rawPurgedAt: null,
    derivedPurgedAt: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  } as MediaAsset;
}

function fakeStore(kind: "s3" | "r2"): ObjectStore & Record<string, ReturnType<typeof vi.fn>> {
  return {
    bucket: kind === "s3" ? "montaj-raw" : "montaj-derived",
    kind,
    createMultipartUpload: vi.fn(async ({ key }: { key: string }) => ({
      key,
      uploadId: "upload-1",
      partSizeBytes: MULTIPART_PART_SIZE_BYTES,
      parts: [{ partNumber: 1, url: "https://store.test/part-1" }],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })),
    completeMultipartUpload: vi.fn(async () => ({ etag: '"final"' })),
    abortMultipartUpload: vi.fn(async () => undefined),
    presignGet: vi.fn(async (key: string) => `https://store.test/${key}?sig=1`),
    presignPut: vi.fn(async () => "https://store.test/put"),
    head: vi.fn(async () => ({ sizeBytes: 2_048 })),
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => Buffer.alloc(0)),
    delete: vi.fn(async () => undefined),
    deleteMany: vi.fn(async (keys: readonly string[]) => keys.length),
    tag: vi.fn(async () => undefined),
  } as unknown as ObjectStore & Record<string, ReturnType<typeof vi.fn>>;
}

function makeService(
  options: { media?: Partial<MediaAsset>; plan?: Record<string, unknown> } = {},
) {
  const stored = mediaRow(options.media ?? {});
  const prisma = {
    mediaAsset: {
      create: vi.fn(async ({ data }: { data: Partial<MediaAsset> }) => mediaRow(data)),
      update: vi.fn(async ({ data }: { data: Partial<MediaAsset> }) =>
        mediaRow({ ...stored, ...data }),
      ),
      findFirst: vi.fn(async () => ({ ...stored, project: projectRow() })),
      findMany: vi.fn(async () => [stored]),
    },
    project: { update: vi.fn(async () => projectRow()) },
  };
  const projects = {
    requireProject: vi.fn(async () => projectRow()),
    touch: vi.fn(async () => undefined),
  };
  const entitlements = { forWorkspace: vi.fn(async () => entitlement(options.plan ?? {})) };
  const jobs = {
    enqueue: vi.fn(async ({ jobKey }: { jobKey: string }) => ({
      job: { id: `job-${jobKey}` },
      deduplicated: false,
    })),
  };
  const raw = fakeStore("s3");
  const derived = fakeStore("r2");

  const service = new MediaService(
    prisma as unknown as PrismaService,
    projects as unknown as ProjectsService,
    entitlements as unknown as EntitlementService,
    jobs as unknown as JobsService,
    raw,
    derived,
  );
  return { service, prisma, projects, entitlements, jobs, raw, derived };
}

describe("normaliseMime", () => {
  it("lowercases and drops parameters", () => {
    expect(normaliseMime(" VIDEO/MP4; codecs=avc1 ")).toBe("video/mp4");
  });
});

describe("assertAllowedType (THREAT-MODEL T7)", () => {
  it("accepts the media types on the allow-list", () => {
    expect(() => assertAllowedType("video/mp4", "clip.mp4")).not.toThrow();
    expect(() => assertAllowedType("audio/flac", "song.flac")).not.toThrow();
  });

  it("accepts octet-stream only when the extension is one we know", () => {
    expect(() => assertAllowedType("application/octet-stream", "clip.mov")).not.toThrow();
    expect(() => assertAllowedType("application/octet-stream", "payload.exe")).toThrow();
  });

  it.each([
    ["application/x-msdownload", "virus.exe"],
    ["text/html", "page.html"],
    ["image/svg+xml", "vector.svg"],
    ["application/zip", "bundle.zip"],
  ])("refuses %s", (mime, filename) => {
    expect(() => assertAllowedType(mime, filename)).toThrow(
      expect.objectContaining({ code: "media/unsupported_type" }),
    );
  });
});

describe("extensionFor", () => {
  it("prefers the filename when it is on the allow-list", () => {
    expect(extensionFor("holiday.MOV", "video/mp4")).toBe("mov");
  });

  it("falls back to the declared media type", () => {
    expect(extensionFor("no-extension", "video/quicktime")).toBe("mov");
    expect(extensionFor("weird.exe", "video/mp4")).toBe("mp4");
  });

  it("never lets an attacker-chosen extension through", () => {
    expect(extensionFor("../../etc/passwd", "audio/mpeg")).toBe("mp3");
    expect(extensionFor("x.php", "application/octet-stream")).toBe("bin");
  });
});

describe("assertWithinPlan", () => {
  it("refuses a file over the plan cap with media/too_large", () => {
    const limits = mediaLimitsFor(entitlement());
    expect(() => assertWithinPlan(limits.maxFileBytes, limits)).not.toThrow();
    expect(() => assertWithinPlan(limits.maxFileBytes + 1, limits)).toThrow(
      expect.objectContaining({ code: "media/too_large", httpStatus: 413 }),
    );
  });
});

describe("MediaService.initUpload", () => {
  let harness: ReturnType<typeof makeService>;

  beforeEach(() => {
    harness = makeService();
  });

  it("writes a CONTRACTS §6 raw key and signs one URL per part", async () => {
    const ticket = await harness.service.initUpload(WORKSPACE, PROJECT, {
      filename: "clip.mp4",
      size: 1_000,
      mime: "video/mp4",
    });

    expect(ticket.key).toMatch(
      new RegExp(`^ws/${WORKSPACE}/p/${PROJECT}/media/[0-9A-HJKMNP-TV-Z]{26}/raw\\.mp4$`),
    );
    expect(ticket.uploadId).toBe("upload-1");
    expect(ticket.parts).toHaveLength(1);
    expect(ticket.duplicate).toBe(false);
    expect(harness.raw.createMultipartUpload).toHaveBeenCalled();
    // The row records the upload so `complete` can finish it.
    const update = callArg(harness.prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    expect(update).toMatchObject({ status: "uploading", uploadId: "upload-1" });
  });

  it("refuses a file over the plan cap before anything is signed", async () => {
    await expect(
      harness.service.initUpload(WORKSPACE, PROJECT, {
        filename: "huge.mp4",
        size: 600 * 1024 * 1024,
        mime: "video/mp4",
      }),
    ).rejects.toMatchObject({ code: "media/too_large" });
    expect(harness.raw.createMultipartUpload).not.toHaveBeenCalled();
    expect(harness.prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("refuses a disallowed media type", async () => {
    await expect(
      harness.service.initUpload(WORKSPACE, PROJECT, {
        filename: "x.exe",
        size: 10,
        mime: "application/x-msdownload",
      }),
    ).rejects.toMatchObject({ code: "media/unsupported_type" });
  });

  it("returns the existing media when the content hash is already here", async () => {
    const settled = mediaRow({ status: "ready", contentHash: "sha256:abc" });
    harness.prisma.mediaAsset.findFirst.mockResolvedValueOnce(settled as never);

    const ticket = await harness.service.initUpload(WORKSPACE, PROJECT, {
      filename: "clip.mp4",
      size: 1_000,
      mime: "video/mp4",
      contentHash: "sha256:abc",
    });

    expect(ticket.duplicate).toBe(true);
    expect(ticket.mediaId).toBe(MEDIA);
    expect(ticket.parts).toEqual([]);
    expect(ticket.uploadId).toBeNull();
    expect(harness.raw.createMultipartUpload).not.toHaveBeenCalled();
    // Deduplication is per workspace, so the lookup joins through the project.
    const where = callArg(harness.prisma.mediaAsset.findFirst, 0, 0).where as Record<
      string,
      unknown
    >;
    expect(where["project"]).toEqual({ workspaceId: WORKSPACE, deletedAt: null });
  });
});

describe("MediaService.complete", () => {
  it("finishes the upload, sets both purge dates and enqueues probe then proxy", async () => {
    const harness = makeService({ media: { uploadId: "upload-1", status: "uploading" } });
    const result = await harness.service.complete(WORKSPACE, MEDIA, ["etag-1", '"etag-2"']);

    // Quoting is normalised for the caller.
    const parts = callArg(harness.raw.completeMultipartUpload, 0, 2) as {
      partNumber: number;
      etag: string;
    }[];
    expect(parts).toEqual([
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);

    const data = callArg(harness.prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    expect(data["status"]).toBe("uploaded");
    expect(data["uploadId"]).toBeNull();
    // The store's own byte count, not the client's claim.
    expect(data["sizeBytes"]).toBe(BigInt(2_048));
    const uploadedAt = data["uploadedAt"] as Date;
    const raw = data["rawPurgeAt"] as Date;
    const derived = data["derivedPurgeAt"] as Date;
    expect(Math.round((raw.getTime() - uploadedAt.getTime()) / 86_400_000)).toBe(7);
    expect(Math.round((derived.getTime() - uploadedAt.getTime()) / 86_400_000)).toBe(7);

    // ONE job, not two (A07). Enqueuing the proxy here as well took two admission
    // slots for one upload, so a Free workspace — lane of two — 429'd on its
    // second concurrent file. The proxy now rides on the probe's completion.
    expect(harness.jobs.enqueue).toHaveBeenCalledTimes(1);
    const [probe] = harness.jobs.enqueue.mock.calls.map((call) => call[0]);
    expect(probe).toMatchObject({
      type: "media.probe",
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      jobKey: MEDIA_JOB_KEYS.probe(MEDIA),
      worstCaseTenths: 0,
    });
    expect(
      harness.jobs.enqueue.mock.calls.map((call) => (call[0] as { type?: string }).type ?? ""),
    ).not.toContain("media.proxy");
    expect(result.probeJobId).toContain("media.probe");
    expect(result.proxyJobId).toBeNull();
  });

  it("uses the plan's retention for the derived clock", async () => {
    const harness = makeService({
      media: { uploadId: "upload-1", status: "uploading" },
      plan: { retentionDays: 90 },
    });
    await harness.service.complete(WORKSPACE, MEDIA, ["etag-1"]);
    const data = callArg(harness.prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    const uploadedAt = data["uploadedAt"] as Date;
    const derived = data["derivedPurgeAt"] as Date;
    expect(Math.round((derived.getTime() - uploadedAt.getTime()) / 86_400_000)).toBe(90);
  });

  it("is idempotent: a retry re-enqueues nothing new and answers with the same jobs", async () => {
    const harness = makeService({ media: { uploadId: null, status: "uploaded" } });
    const result = await harness.service.complete(WORKSPACE, MEDIA, ["etag-1"]);
    expect(harness.raw.completeMultipartUpload).not.toHaveBeenCalled();
    expect(result.probeJobId).toContain("media.probe");
    expect(result.proxyJobId).toBeNull();
  });

  it("refuses when there is no upload and nothing has landed", async () => {
    const harness = makeService({ media: { uploadId: null, status: "pending" } });
    await expect(harness.service.complete(WORKSPACE, MEDIA, ["e"])).rejects.toMatchObject({
      code: "media/invalid_state",
    });
  });

  it("deletes the object and fails the row when the real size breaks the plan cap", async () => {
    const harness = makeService({ media: { uploadId: "upload-1", status: "uploading" } });
    asMock(harness.raw.head).mockResolvedValueOnce({ sizeBytes: 900 * 1024 * 1024 });

    await expect(harness.service.complete(WORKSPACE, MEDIA, ["e"])).rejects.toMatchObject({
      code: "media/too_large",
    });
    expect(harness.raw.delete).toHaveBeenCalledWith(mediaRow().storageKey);
    expect(harness.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("turns a store failure into media/upload_failed rather than a 500", async () => {
    const harness = makeService({ media: { uploadId: "upload-1", status: "uploading" } });
    asMock(harness.raw.completeMultipartUpload).mockRejectedValueOnce(new Error("InvalidPart"));
    await expect(harness.service.complete(WORKSPACE, MEDIA, ["e"])).rejects.toMatchObject({
      code: "media/upload_failed",
    });
  });

  it("answers 404 for another tenant's media id", async () => {
    const harness = makeService();
    harness.prisma.mediaAsset.findFirst.mockResolvedValueOnce(null as never);
    await expect(harness.service.complete(WORKSPACE, MEDIA, ["e"])).rejects.toMatchObject({
      code: "media/not_found",
      httpStatus: 404,
    });
  });
});

describe("MediaService.replace", () => {
  it("keeps the row, flags a re-align and clears the stale derived keys", async () => {
    const harness = makeService({
      media: {
        uploadId: "old-upload",
        status: "ready",
        proxyKey: "ws/x/proxy540.mp4",
        thumbKeys: ["ws/x/thumb-0.jpg"],
      },
    });

    const ticket = await harness.service.replace(WORKSPACE, PROJECT, MEDIA, {
      filename: "new.mov",
      size: 2_000,
      mime: "video/quicktime",
    });

    expect(ticket.mediaId).toBe(MEDIA);
    // The abandoned upload is not left holding parts in the bucket.
    expect(harness.raw.abortMultipartUpload).toHaveBeenCalledWith(
      mediaRow().storageKey,
      "old-upload",
    );
    const data = callArg(harness.prisma.mediaAsset.update, 0, 0).data as Record<string, unknown>;
    expect(data["needsRealign"]).toBe(true);
    expect(data["proxyKey"]).toBeNull();
    expect(data["thumbKeys"]).toEqual([]);
    expect(data["uploadedAt"]).toBeNull();
    expect(String(data["storageKey"])).toMatch(/raw\.mov$/);
  });
});

describe("MediaService.urls", () => {
  it("signs only the artefacts that exist", async () => {
    const harness = makeService({
      media: {
        proxyKey: "ws/a/proxy540.mp4",
        audio16kKey: "ws/a/audio16k.wav",
        thumbKeys: ["ws/a/thumb-0.jpg", "ws/a/thumb-1.jpg"],
      },
    });
    const urls = await harness.service.urls(WORKSPACE, PROJECT, MEDIA);
    expect(urls.proxy).toContain("proxy540.mp4");
    expect(urls.audio16k).toContain("audio16k.wav");
    expect(urls.audio48k).toBeUndefined();
    expect(urls.waveform).toBeUndefined();
    expect(urls.thumbs).toHaveLength(2);
    // Five minutes, from the derived store and never the raw one.
    expect(harness.derived.presignGet).toHaveBeenCalledWith("ws/a/proxy540.mp4", 300);
    expect(harness.raw.presignGet).not.toHaveBeenCalled();
    expect(new Date(urls.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("toMediaView", () => {
  it("renders bigints as numbers and dates as ISO-8601", () => {
    const view = toMediaView(
      mediaRow({ sizeBytes: BigInt(4_096), uploadedAt: new Date("2026-09-02T01:00:00.000Z") }),
    );
    expect(view.sizeBytes).toBe(4_096);
    expect(view.uploadedAt).toBe("2026-09-02T01:00:00.000Z");
    expect(view.derived).toEqual({
      proxy: null,
      audio16k: null,
      audio48k: null,
      waveform: null,
      thumbs: [],
    });
  });
});
