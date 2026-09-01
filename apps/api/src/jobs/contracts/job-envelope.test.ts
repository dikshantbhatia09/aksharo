import { describe, expect, it } from "vitest";

import { JobEnvelopeSchema, buildJobEnvelope, isJobEnvelope } from "./job-envelope.js";

const BASE = {
  jobId: "01JC0000000000000000000000",
  attemptId: "01JC0000000000000000000001",
  workspaceId: "01JC0000000000000000000002",
  priority: 3,
  jobKey: "media:01JC…:probe",
  createdAt: new Date("2026-09-02T10:00:00.000Z"),
  payload: { mediaId: "01JC0000000000000000000003" },
};

describe("buildJobEnvelope (CONTRACTS §3)", () => {
  it("produces exactly the contract fields", () => {
    const envelope = buildJobEnvelope({ ...BASE, projectId: "01JC0000000000000000000004" });
    expect(Object.keys(envelope).sort()).toEqual([
      "attemptId",
      "createdAt",
      "jobId",
      "jobKey",
      "payload",
      "priority",
      "projectId",
      "workspaceId",
    ]);
    expect(envelope.createdAt).toBe("2026-09-02T10:00:00.000Z");
  });

  it("OMITS projectId rather than sending null", () => {
    // `apps/worker-ai` rejects a non-string projectId; JSON.stringify keeps null
    // but drops undefined, so the key has to be absent, not nulled.
    for (const projectId of [undefined, null]) {
      const envelope = buildJobEnvelope({ ...BASE, projectId });
      expect("projectId" in envelope).toBe(false);
      expect(JSON.parse(JSON.stringify(envelope))).not.toHaveProperty("projectId");
    }
  });

  it("keeps every id a string, which is what the Python worker requires", () => {
    const wire = JSON.parse(JSON.stringify(buildJobEnvelope(BASE))) as Record<string, unknown>;
    for (const field of ["jobId", "attemptId", "workspaceId", "jobKey", "createdAt"]) {
      expect(typeof wire[field]).toBe("string");
    }
    expect(typeof wire["payload"]).toBe("object");
    expect(typeof wire["priority"]).toBe("number");
  });

  it("survives a JSON round trip unchanged, which is what BullMQ does to it", () => {
    const envelope = buildJobEnvelope({ ...BASE, projectId: "01JC0000000000000000000004" });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});

describe("isJobEnvelope", () => {
  it("accepts a built envelope", () => {
    expect(isJobEnvelope(buildJobEnvelope(BASE))).toBe(true);
  });

  it("rejects a missing or mistyped field", () => {
    const envelope = buildJobEnvelope(BASE) as Record<string, unknown>;
    expect(isJobEnvelope({ ...envelope, jobId: undefined })).toBe(false);
    expect(isJobEnvelope({ ...envelope, attemptId: 7 })).toBe(false);
    expect(isJobEnvelope({ ...envelope, payload: "not an object" })).toBe(false);
    expect(isJobEnvelope({ ...envelope, priority: -1 })).toBe(false);
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope("envelope")).toBe(false);
  });

  it("keeps unknown payload keys, because payloads belong to the job type's owner", () => {
    const parsed = JobEnvelopeSchema.parse({
      ...buildJobEnvelope(BASE),
      payload: { anything: { nested: true } },
    });
    expect(parsed.payload).toEqual({ anything: { nested: true } });
  });
});
