import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MEDIA_PROBE_QUEUE,
  MEDIA_PROXY_QUEUE,
  MEDIA_QUEUES,
  QUEUE_NAMES,
  isJobEnvelope,
  isMediaPayload,
} from "./queues.js";

/**
 * The queue list is duplicated in four places by necessity — no package here can
 * import another app's source. So each copy is checked against the API's, which is
 * the one CONTRACTS §3 names.
 */
const API_QUEUE_NAMES = resolve(__dirname, "../../api/src/jobs/contracts/queue-names.ts");

const validEnvelope = {
  jobId: "01JBQ8Z2W4N7Y0K3M5P8R1T6V9",
  attemptId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VA",
  workspaceId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VB",
  projectId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VC",
  priority: 5,
  jobKey: "media.probe:01JBQ8Z2W4N7Y0K3M5P8R1T6VD",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { mediaId: "01JBQ8Z2W4N7Y0K3M5P8R1T6VD", key: "ws/a/p/b/media/c/raw.mp4" },
};

describe("queue contract (CONTRACTS §3)", () => {
  it("lists all fourteen frozen queue names", () => {
    expect(QUEUE_NAMES).toHaveLength(14);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });

  it("matches the API's canonical list, name for name and in order", () => {
    const source = readFileSync(API_QUEUE_NAMES, "utf8");
    const block = source.slice(
      source.indexOf("export const QUEUE_NAMES"),
      source.indexOf("] as const", source.indexOf("export const QUEUE_NAMES")),
    );
    const fromApi = [...block.matchAll(/"([\w.]+)"/g)].map((match) => match[1]);
    expect(fromApi).toEqual([...QUEUE_NAMES]);
  });

  it("consumes exactly the two media queues", () => {
    expect(MEDIA_PROBE_QUEUE).toBe("media.probe");
    expect(MEDIA_PROXY_QUEUE).toBe("media.proxy");
    expect(MEDIA_QUEUES).toEqual(["media.probe", "media.proxy"]);
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
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
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

describe("isMediaPayload", () => {
  it("needs a media id and a raw key, both non-empty", () => {
    expect(isMediaPayload({ mediaId: "m", key: "k" })).toBe(true);
    expect(isMediaPayload({ mediaId: "", key: "k" })).toBe(false);
    expect(isMediaPayload({ mediaId: "m", key: "" })).toBe(false);
    expect(isMediaPayload({ mediaId: "m" })).toBe(false);
    expect(isMediaPayload(null)).toBe(false);
  });
});
