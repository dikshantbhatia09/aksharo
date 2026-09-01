import { describe, expect, it } from "vitest";

import { RENDER_SUBTITLE_QUEUE, RENDER_VIDEO_QUEUE, isJobEnvelope } from "./queues.js";

describe("render queue contract (CONTRACTS section 3)", () => {
  it("uses the frozen queue names", () => {
    expect(RENDER_VIDEO_QUEUE).toBe("render.video");
    expect(RENDER_SUBTITLE_QUEUE).toBe("render.subtitle");
  });
});

describe("isJobEnvelope", () => {
  const envelope = {
    jobId: "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
    attemptId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
    workspaceId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
    priority: 5,
    jobKey: "render.video:01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" },
  };

  it("accepts a well-formed envelope", () => {
    expect(isJobEnvelope(envelope)).toBe(true);
  });

  it("rejects a job whose data is not the contract envelope", () => {
    expect(isJobEnvelope({ exportId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC" })).toBe(false);
    expect(isJobEnvelope(null)).toBe(false);
  });
});
