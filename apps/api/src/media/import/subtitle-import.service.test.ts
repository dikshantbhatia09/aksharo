import { describe, expect, it, vi } from "vitest";

import { kindFromUrl, SubtitleImportService } from "./subtitle-import.service.js";
import { callArg } from "../../../test/mock-args.js";
import { MEDIA_JOB_KEYS } from "../media.constants.js";

import type { PrismaService } from "../../common/index.js";
import type { ObjectStore } from "../../common/storage/index.js";
import type { JobsService } from "../../jobs/jobs.service.js";
import type { ProjectsService } from "../../projects/projects.service.js";
import type { EntitlementService, EntitlementView } from "../../workspaces/entitlement.service.js";
import type { Project } from "@prisma/client";

const WORKSPACE = "01JBZ0Q4T7R8N4H1V0J9K2M3P5";
const PROJECT = "01JBZ0Q4T7R8N4H1V0J9K2M3P6";
const PRIMARY_MEDIA = "01JBZ0Q4T7R8N4H1V0J9K2M3P7";

const SRT = "1\n00:00:01,000 --> 00:00:03,500\nनमस्ते\n";

function entitlement(): EntitlementView {
  return {
    workspaceId: WORKSPACE,
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 300,
    seatsIncluded: 0,
    seatsUsed: 1,
    entitlements: { maxFileBytes: 1, maxDurationMs: 1, retentionDays: 7 },
    computedAt: new Date().toISOString(),
  };
}

function projectRow(): Project {
  return {
    id: PROJECT,
    workspaceId: WORKSPACE,
    title: "A project",
    folderId: null,
    batchId: null,
    clientTag: null,
    sourceLanguage: "hi",
    scripts: [],
    aspect: "r9x16",
    status: "draft",
    reviewStatus: "none",
    thumbnailKey: null,
    durationMs: null,
    lastActivityAt: new Date(),
    retentionUntil: null,
    createdBy: null,
    createdAt: new Date(),
    deletedAt: null,
  } as Project;
}

function makeService() {
  const prisma = {
    mediaAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => ({ id: PRIMARY_MEDIA })),
    },
  };
  const projects = {
    requireProject: vi.fn(async () => projectRow()),
    touch: vi.fn(async () => undefined),
  };
  const entitlements = { forWorkspace: vi.fn(async () => entitlement()) };
  const jobs = { enqueue: vi.fn(async () => ({ job: { id: "job-1" }, deduplicated: false })) };
  const derived = {
    kind: "r2" as const,
    bucket: "montaj-derived",
    put: vi.fn(async () => undefined),
  } as unknown as ObjectStore & Record<string, ReturnType<typeof vi.fn>>;

  const service = new SubtitleImportService(
    prisma as unknown as PrismaService,
    projects as unknown as ProjectsService,
    entitlements as unknown as EntitlementService,
    jobs as unknown as JobsService,
    derived,
  );
  return { service, prisma, projects, jobs, derived };
}

describe("kindFromUrl", () => {
  it.each([
    ["https://example.com/subs.srt", "srt"],
    ["https://example.com/subs.VTT?x=1", "vtt"],
    ["https://example.com/subs.ssa#frag", "ass"],
    ["https://example.com/script.txt", "txt"],
  ])("reads %s as %s", (url, kind) => {
    expect(kindFromUrl(url)).toBe(kind);
  });

  it("is undefined when the URL says nothing useful", () => {
    expect(kindFromUrl("https://example.com/download")).toBeUndefined();
  });
});

describe("importInline", () => {
  it("stores the cue list in the derived bucket under the media prefix", async () => {
    const { service, derived, prisma } = makeService();
    const result = await service.importInline(WORKSPACE, PROJECT, { kind: "srt", content: SRT });

    expect(result.cueCount).toBe(1);
    expect(result.timed).toBe(true);
    expect(result.key).toMatch(
      new RegExp(`^ws/${WORKSPACE}/p/${PROJECT}/media/[0-9A-HJKMNP-TV-Z]{26}/subtitle\\.json$`),
    );

    const written = callArg(derived.put, 0, 0) as { key: string; body: string };
    const document = JSON.parse(written.body) as {
      version: number;
      cues: { text: string }[];
      language: string | null;
    };
    expect(document.version).toBe(1);
    expect(document.cues[0]?.text).toBe("नमस्ते");
    // No language was given, so the project's source language is used.
    expect(document.language).toBe("hi");

    const row = callArg(prisma.mediaAsset.create, 0, 0).data as Record<string, unknown>;
    expect(row["role"]).toBe("subtitle");
    expect(row["bucket"]).toBe("r2");
    expect(row["status"]).toBe("ready");
    // An import has no raw object, so there is nothing to purge at seven days.
    expect(row["rawPurgeAt"]).toBeUndefined();
    expect(row["derivedPurgeAt"]).toBeInstanceOf(Date);
  });

  it("enqueues ai.align against the project's primary media", async () => {
    const { service, jobs } = makeService();
    await service.importInline(WORKSPACE, PROJECT, { kind: "srt", content: SRT });

    const enqueued = callArg(jobs.enqueue, 0, 0) as Record<string, unknown>;
    expect(enqueued["type"]).toBe("ai.align");
    expect(enqueued["workspaceId"]).toBe(WORKSPACE);
    expect(enqueued["worstCaseTenths"]).toBe(0);
    expect(String(enqueued["jobKey"])).toMatch(/^ai\.align:/);
    expect((enqueued["params"] as Record<string, unknown>)["mediaId"]).toBe(PRIMARY_MEDIA);
  });

  it("uses the media the caller named, and checks it is in this project", async () => {
    const { service, prisma, jobs } = makeService();
    await service.importInline(WORKSPACE, PROJECT, {
      kind: "srt",
      content: SRT,
      mediaId: PRIMARY_MEDIA,
    });
    expect(prisma.mediaAsset.count).toHaveBeenCalledWith({
      where: { id: PRIMARY_MEDIA, projectId: PROJECT },
    });
    const params = callArg(jobs.enqueue, 0, 0).params as Record<string, unknown>;
    expect(params["mediaId"]).toBe(PRIMARY_MEDIA);
  });

  it("refuses a media id from another project", async () => {
    const { service, prisma } = makeService();
    prisma.mediaAsset.count.mockResolvedValueOnce(0 as never);
    await expect(
      service.importInline(WORKSPACE, PROJECT, {
        kind: "srt",
        content: SRT,
        mediaId: PRIMARY_MEDIA,
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("marks plain text as untimed, which is the signal align needs", async () => {
    const { service } = makeService();
    const result = await service.importInline(WORKSPACE, PROJECT, {
      kind: "txt",
      content: "line one\nline two\n",
    });
    expect(result.timed).toBe(false);
    expect(result.cueCount).toBe(2);
  });

  it("refuses a body over 2 MB", async () => {
    const { service } = makeService();
    await expect(
      service.importInline(WORKSPACE, PROJECT, {
        kind: "srt",
        content: "x".repeat(2 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "import/too_large", httpStatus: 413 });
  });

  it("answers import/unparsable for a file that is not what it claims", async () => {
    const { service, derived } = makeService();
    await expect(
      service.importInline(WORKSPACE, PROJECT, { kind: "srt", content: "not a subtitle file" }),
    ).rejects.toMatchObject({ code: "import/unparsable", httpStatus: 422 });
    expect(derived.put).not.toHaveBeenCalled();
  });

  it("uses the job key so a repeated import cannot double-align", async () => {
    const { service, jobs } = makeService();
    const result = await service.importInline(WORKSPACE, PROJECT, { kind: "srt", content: SRT });
    expect(callArg(jobs.enqueue, 0, 0).jobKey).toBe(MEDIA_JOB_KEYS.align(result.mediaId));
  });
});
