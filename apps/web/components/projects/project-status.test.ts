import { describe, expect, it } from "vitest";

import type { JobSummary, Project } from "@montaj/api-client";

import { activeJobFor, projectCardStatus } from "./project-status";


function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE000000000000A",
    title: "A project",
    folderId: null,
    clientTag: null,
    sourceLanguage: null,
    scripts: [],
    aspect: "9:16",
    status: "draft",
    thumbnailKey: null,
    durationMs: null,
    mediaCount: 0,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    retentionUntil: null,
    createdBy: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "01JJOB000000000000000000A",
    type: "media.probe",
    status: "running",
    priority: 0,
    progress: 0,
    etaMs: null,
    projectId: "01JPROJECT0000000000000AA",
    jobKey: "media.probe:x",
    attemptId: null,
    creditsChargedTenths: 0,
    maxQueueWaitMs: null,
    result: null,
    error: null,
    provider: null,
    model: null,
    queuedAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("projectCardStatus", () => {
  it("is archived when the project itself is archived, regardless of jobs", () => {
    expect(projectCardStatus(project({ status: "archived" }), [job()])).toBe("archived");
  });

  it("is failed when any of its jobs failed", () => {
    expect(projectCardStatus(project(), [job({ status: "failed" })])).toBe("failed");
  });

  it("is processing while a job is running", () => {
    expect(projectCardStatus(project(), [job({ status: "running" })])).toBe("processing");
  });

  it("is queued when a job is queued but nothing is running yet", () => {
    expect(projectCardStatus(project(), [job({ status: "queued" })])).toBe("queued");
  });

  it("is draft with no media and no jobs", () => {
    expect(projectCardStatus(project({ mediaCount: 0 }), [])).toBe("draft");
  });

  it("is ready once media exists and nothing is still running", () => {
    expect(projectCardStatus(project({ mediaCount: 1 }), [job({ status: "succeeded" })])).toBe(
      "ready",
    );
  });

  it("ignores another project's jobs", () => {
    expect(
      projectCardStatus(project({ mediaCount: 1 }), [
        job({ projectId: "01JOTHERPROJECT000000000A", status: "running" }),
      ]),
    ).toBe("ready");
  });
});

describe("activeJobFor", () => {
  it("returns undefined when nothing is live", () => {
    expect(activeJobFor(project(), [job({ status: "succeeded" })])).toBeUndefined();
  });

  it("returns the newest of the live jobs", () => {
    const older = job({ id: "old", status: "running", queuedAt: "2026-09-02T00:00:00.000Z" });
    const newer = job({ id: "new", status: "queued", queuedAt: "2026-09-02T01:00:00.000Z" });
    expect(activeJobFor(project(), [older, newer])?.id).toBe("new");
  });
});
