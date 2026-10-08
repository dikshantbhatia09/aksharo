import { describe, expect, it, vi } from "vitest";

import { MEDIA_STALE_REAPER_TASK, STALE_MEDIA_REAPER_CRON } from "./media.constants.js";
import { StaleMediaReaperService } from "./stale-media-reaper.service.js";
import { StaleMediaReaperTask } from "./stale-media-reaper.task.js";

import type { CommonAuditService } from "../common/audit/audit.service.js";
import type { PrismaService } from "../common/index.js";
import type { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";
import type { ObjectStore } from "../common/storage/index.js";
import type { MediaStatus } from "@prisma/client";

const NOW = new Date("2026-09-19T12:00:00.000Z");

interface MockAsset {
  id: string;
  projectId: string;
  status: MediaStatus;
  storageKey: string;
  uploadId: string | null;
  failureReason?: string | null;
  createdAt: Date;
  uploadedAt: Date | null;
  project: { workspaceId: string };
}

interface MockJob {
  id: string;
  status: string;
  jobKey: string;
  params: Record<string, unknown>;
}

function createHarness(initialAssets: MockAsset[] = [], initialJobs: MockJob[] = []) {
  const assets = new Map(initialAssets.map((a) => [a.id, { ...a }]));
  const jobs = [...initialJobs];

  const prisma = {
    mediaAsset: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        return Array.from(assets.values()).filter((a) => {
          if (where.status?.in && !where.status.in.includes(a.status)) {
            return false;
          }
          if (where.createdAt?.lte && a.createdAt > where.createdAt.lte) {
            return false;
          }
          if (where.OR) {
            const matchesOr = where.OR.some((condition: any) => {
              if ("uploadedAt" in condition) {
                if (condition.uploadedAt === null) return a.uploadedAt === null;
                if (condition.uploadedAt?.lte) return a.uploadedAt !== null && a.uploadedAt <= condition.uploadedAt.lte;
              }
              return false;
            });
            if (!matchesOr) return false;
          }
          return true;
        });
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        const existing = assets.get(where.id);
        if (existing) {
          Object.assign(existing, data);
          return existing;
        }
        return null;
      }),
    },
    job: {
      findFirst: vi.fn(async ({ where }: { where: any }) => {
        return jobs.find((j) => {
          if (where.status?.in && !where.status.in.includes(j.status)) {
            return false;
          }
          if (where.OR) {
            return where.OR.some((orClause: any) => {
              if (orClause.jobKey?.contains && j.jobKey.includes(orClause.jobKey.contains)) {
                return true;
              }
              if (orClause.params?.path && orClause.params.equals) {
                const key = orClause.params.path[0];
                const paramsMap = new Map(Object.entries(j.params));
                return paramsMap.get(key) === orClause.params.equals;
              }
              return false;
            });
          }
          return false;
        }) ?? null;
      }),
    },
  };

  const raw = {
    abortMultipartUpload: vi.fn(async () => undefined),
  };

  const audit = {
    record: vi.fn(async () => undefined),
  };

  const service = new StaleMediaReaperService(
    prisma as unknown as PrismaService,
    raw as unknown as ObjectStore,
    audit as unknown as CommonAuditService,
  );

  return { service, prisma, raw, audit, getAssets: () => Array.from(assets.values()) };
}

describe("StaleMediaReaperService (CORE-016)", () => {
  it("Rule 1: moves stuck 'uploading' asset (>24h) to failed, aborts multipart upload, and records audit event", async () => {
    const asset: MockAsset = {
      id: "media-uploading-1",
      projectId: "proj-1",
      status: "uploading",
      storageKey: "ws/proj/media-uploading-1.mp4",
      uploadId: "mp-upload-xyz",
      createdAt: new Date("2026-09-17T10:00:00.000Z"), // 50 hours ago
      uploadedAt: null,
      project: { workspaceId: "ws-1" },
    };

    const { service, raw, audit, getAssets } = createHarness([asset]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(1);
    expect(report.reaped).toBe(1);
    expect(report.abortedUploads).toBe(1);
    expect(report.reapedMediaIds).toEqual(["media-uploading-1"]);

    // Aborted multipart upload on raw store
    expect(raw.abortMultipartUpload).toHaveBeenCalledWith("ws/proj/media-uploading-1.mp4", "mp-upload-xyz");

    // Asset status updated to failed with reason
    const updated = getAssets().find((a) => a.id === "media-uploading-1");
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("media/stale_upload");
    expect(updated?.uploadId).toBeNull();

    // Audit event recorded
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "media.stale_reaped",
        resource: "media_asset",
        resourceId: "media-uploading-1",
        workspaceId: "ws-1",
        data: expect.objectContaining({
          previousStatus: "uploading",
          reason: "media/stale_upload",
          hadUploadId: true,
        }),
      }),
    );
  });

  it("Rule 2: moves stuck 'probing' asset (>24h) to failed with reason and records audit event", async () => {
    const asset: MockAsset = {
      id: "media-probing-1",
      projectId: "proj-2",
      status: "probing",
      storageKey: "ws/proj/media-probing-1.mp4",
      uploadId: null,
      createdAt: new Date("2026-09-18T10:00:00.000Z"), // 26 hours ago
      uploadedAt: new Date("2026-09-18T10:30:00.000Z"), // 25.5 hours ago
      project: { workspaceId: "ws-2" },
    };

    const { service, raw, audit, getAssets } = createHarness([asset]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(1);
    expect(report.reaped).toBe(1);
    expect(report.abortedUploads).toBe(0);
    expect(raw.abortMultipartUpload).not.toHaveBeenCalled();

    const updated = getAssets().find((a) => a.id === "media-probing-1");
    expect(updated?.status).toBe("failed");
    expect(updated?.failureReason).toBe("media/stale_upload");

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "media.stale_reaped",
        resource: "media_asset",
        resourceId: "media-probing-1",
        workspaceId: "ws-2",
        data: expect.objectContaining({
          previousStatus: "probing",
          reason: "media/stale_upload",
          hadUploadId: false,
        }),
      }),
    );
  });

  it("Rule 3: never touches a ready asset (>24h old)", async () => {
    const readyAsset: MockAsset = {
      id: "media-ready-1",
      projectId: "proj-3",
      status: "ready",
      storageKey: "ws/proj/media-ready-1.mp4",
      uploadId: null,
      createdAt: new Date("2026-09-15T00:00:00.000Z"), // 4 days ago
      uploadedAt: new Date("2026-09-15T00:05:00.000Z"),
      project: { workspaceId: "ws-3" },
    };

    const { service, raw, audit, getAssets } = createHarness([readyAsset]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(0);
    expect(report.reaped).toBe(0);
    expect(raw.abortMultipartUpload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    const untouched = getAssets().find((a) => a.id === "media-ready-1");
    expect(untouched?.status).toBe("ready");
  });

  it("Rule 4: never touches an asset with a queued job", async () => {
    const asset: MockAsset = {
      id: "media-queued-job",
      projectId: "proj-4",
      status: "probing",
      storageKey: "ws/proj/media-queued-job.mp4",
      uploadId: null,
      createdAt: new Date("2026-09-17T00:00:00.000Z"), // 2.5 days ago
      uploadedAt: new Date("2026-09-17T00:10:00.000Z"),
      project: { workspaceId: "ws-4" },
    };
    const queuedJob: MockJob = {
      id: "job-1",
      status: "queued",
      jobKey: "media.probe:media-queued-job",
      params: { mediaId: "media-queued-job" },
    };

    const { service, raw, audit, getAssets } = createHarness([asset], [queuedJob]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(1);
    expect(report.reaped).toBe(0);
    expect(report.skippedActiveJobs).toBe(1);
    expect(raw.abortMultipartUpload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    const untouched = getAssets().find((a) => a.id === "media-queued-job");
    expect(untouched?.status).toBe("probing");
  });

  it("Rule 5: never touches an asset with a running job", async () => {
    const asset: MockAsset = {
      id: "media-running-job",
      projectId: "proj-5",
      status: "uploading",
      storageKey: "ws/proj/media-running-job.mp4",
      uploadId: "mp-running",
      createdAt: new Date("2026-09-17T00:00:00.000Z"),
      uploadedAt: null,
      project: { workspaceId: "ws-5" },
    };
    const runningJob: MockJob = {
      id: "job-2",
      status: "running",
      jobKey: "media.transcode:media-running-job",
      params: { mediaId: "media-running-job" },
    };

    const { service, raw, audit, getAssets } = createHarness([asset], [runningJob]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(1);
    expect(report.reaped).toBe(0);
    expect(report.skippedActiveJobs).toBe(1);
    expect(raw.abortMultipartUpload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    const untouched = getAssets().find((a) => a.id === "media-running-job");
    expect(untouched?.status).toBe("uploading");
  });

  it("Rule 6: does NOT touch fresh assets (<24h old)", async () => {
    const recentAsset: MockAsset = {
      id: "media-recent",
      projectId: "proj-6",
      status: "uploading",
      storageKey: "ws/proj/media-recent.mp4",
      uploadId: "mp-recent",
      createdAt: new Date("2026-09-19T10:00:00.000Z"), // 2 hours ago
      uploadedAt: null,
      project: { workspaceId: "ws-6" },
    };

    const { service, raw, audit, getAssets } = createHarness([recentAsset]);

    const report = await service.reapStaleMedia({ now: NOW });

    expect(report.checked).toBe(0);
    expect(report.reaped).toBe(0);
    expect(raw.abortMultipartUpload).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    const untouched = getAssets().find((a) => a.id === "media-recent");
    expect(untouched?.status).toBe("uploading");
  });

  it("supports configurable thresholdMs", async () => {
    const asset: MockAsset = {
      id: "media-custom-threshold",
      projectId: "proj-7",
      status: "pending",
      storageKey: "ws/proj/media-custom-threshold.mp4",
      uploadId: null,
      createdAt: new Date("2026-09-19T10:00:00.000Z"), // 2 hours ago
      uploadedAt: null,
      project: { workspaceId: "ws-7" },
    };

    const { service, getAssets } = createHarness([asset]);

    // Default 24h threshold: not reaped
    const report1 = await service.reapStaleMedia({ now: NOW });
    expect(report1.checked).toBe(0);

    // 1h threshold (3600_000 ms): reaped
    const report2 = await service.reapStaleMedia({ now: NOW, thresholdMs: 3600_000 });
    expect(report2.checked).toBe(1);
    expect(report2.reaped).toBe(1);
    expect(getAssets().find((a) => a.id === "media-custom-threshold")?.status).toBe("failed");
  });
});

describe("StaleMediaReaperTask", () => {
  it("registers with ScheduledTasksService on module init", () => {
    const reaper = {
      reapStaleMedia: vi.fn(async () => ({ checked: 0, reaped: 0, skippedActiveJobs: 0, abortedUploads: 0, reapedMediaIds: [] })),
    };
    const scheduler = {
      register: vi.fn(),
    };

    const task = new StaleMediaReaperTask(
      reaper as unknown as StaleMediaReaperService,
      scheduler as unknown as ScheduledTasksService,
    );

    task.onModuleInit();

    expect(scheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: MEDIA_STALE_REAPER_TASK,
        cron: STALE_MEDIA_REAPER_CRON,
        run: expect.any(Function),
      }),
    );
  });
});
