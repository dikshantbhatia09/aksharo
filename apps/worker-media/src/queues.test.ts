import { describe, expect, it } from "vitest";

import { MEDIA_PROBE_QUEUE, QUEUE_NAMES, isJobEnvelope } from "./queues.js";

const validEnvelope = {
  jobId: "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
  attemptId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
  workspaceId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
  projectId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
  priority: 5,
  jobKey: "media.probe:01JBQ8Z2W4N7Y0K3M5P8R1T6VD",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { mediaId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VD", rawKey: "ws/a/p/b/media/c/raw.mp4" },
};

describe("queue contract (CONTRACTS section 3)", () => {
  it("lists all fourteen frozen queue names", () => {
    expect(QUEUE_NAMES).toHaveLength(14);
    expect(QUEUE_NAMES).toContain("media.probe");
    expect(QUEUE_NAMES).toContain("render.subtitle");
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });

  it("consumes media.probe", () => {
    expect(MEDIA_PROBE_QUEUE).toBe("media.probe");
  });
});

describe("isJobEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    expect(isJobEnvelope(validEnvelope)).toBe(true);
  });

  it("accepts an envelope without the optional projectId", () => {
    const { projectId: _projectId, ...withoutProject } = validEnvelope;
    expect(isJobEnvelope(withoutProject)).toBe(true);
  });

  it("rejects anything missing a contract field", () => {
    for (const field of ["jobId", "attemptId", "workspaceId", "jobKey", "createdAt", "payload"]) {
      const broken: Record<string, unknown> = { ...validEnvelope };
      delete broken[field];
      expect(isJobEnvelope(broken), `should reject a job missing ${field}`).toBe(false);
    }
  });

  it("rejects non-objects", () => {
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope(undefined)).toBe(false);
    expect(isJobEnvelope("media.probe")).toBe(false);
    expect(isJobEnvelope(42)).toBe(false);
  });
});
