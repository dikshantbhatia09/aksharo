import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ClipCandidateSchema,
  ClipVariantViewSchema,
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  ManualCandidateRequestSchema,
  RepurposeClipViewSchema,
  RunConfigSchema,
  SAFE_ERROR_CODES,
  StageProgressSchema,
} from "./schema.js";

const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLIP_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const VARIANT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

function fixture(name: string): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as unknown;
}

describe("repurpose@1 fixture contracts", () => {
  it("accepts documented configuration, candidate and URL-create examples", () => {
    expect(RunConfigSchema.safeParse(fixture("run-config.v1.json")).success).toBe(true);
    expect(ClipCandidateSchema.safeParse(fixture("candidate.v1.json")).success).toBe(true);
    expect(CreateRunRequestSchema.safeParse(fixture("create-run-request.v1.json")).success).toBe(
      true,
    );
    expect(CreateRunResponseSchema.safeParse(fixture("create-run-response.v1.json")).success).toBe(
      true,
    );
    expect(
      CreateRunResponseSchema.safeParse(fixture("create-upload-response.v1.json")).success,
    ).toBe(true);
    expect(
      ManualCandidateRequestSchema.safeParse(fixture("manual-candidate-request.v1.json")).success,
    ).toBe(true);
    expect(RepurposeClipViewSchema.safeParse(fixture("clip-view.v1.json")).success).toBe(true);
  });

  it("rejects version drift, unknown enums and extra setup fields", () => {
    const config = RunConfigSchema.parse(fixture("run-config.v1.json"));
    expect(RunConfigSchema.safeParse({ ...config, schemaVersion: 2 }).success).toBe(false);
    expect(
      RunConfigSchema.safeParse({ ...config, formats: [{ ...config.formats[0], aspect: "3:2" }] })
        .success,
    ).toBe(false);
    expect(RunConfigSchema.safeParse({ ...config, surprise: true }).success).toBe(false);
    expect(
      RunConfigSchema.safeParse({ ...config, formats: [config.formats[0], config.formats[0]] })
        .success,
    ).toBe(false);
  });

  it("rejects inverted or excessive bounds and missing AI score evidence", () => {
    const candidate = ClipCandidateSchema.parse(fixture("candidate.v1.json"));
    expect(ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs }).success).toBe(
      false,
    );
    expect(
      ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs + 2_999 }).success,
    ).toBe(false);
    expect(
      ClipCandidateSchema.safeParse({ ...candidate, endMs: candidate.startMs + 180_001 }).success,
    ).toBe(false);
    expect(ClipCandidateSchema.safeParse({ ...candidate, scoreBreakdown: null }).success).toBe(
      false,
    );
    expect(ClipCandidateSchema.safeParse({ ...candidate, potentialScore: 101 }).success).toBe(
      false,
    );
    expect(
      ClipCandidateSchema.safeParse({
        ...candidate,
        signals: { ...candidate.signals, faceId: "person-1" },
      }).success,
    ).toBe(false);
  });

  it("requires rights attestation, HTTPS and bounded upload metadata", () => {
    const request = CreateRunRequestSchema.parse(fixture("create-run-request.v1.json"));
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: { ...request.source, rightsAttested: false },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        setup: {
          ...request.setup,
          discovery: { ...request.setup.discovery, mode: "manual", requestedCandidates: 5 },
        },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: { ...request.source, url: "http://example.com/a.mp4" },
      }).success,
    ).toBe(false);
    expect(
      CreateRunRequestSchema.safeParse({
        ...request,
        source: {
          kind: "upload",
          filename: "clip.mp4",
          mime: "video/mp4",
          sizeBytes: 0,
          rightsAttested: true,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps candidate manual mode free of AI evidence", () => {
    const candidate = ClipCandidateSchema.parse(fixture("candidate.v1.json"));
    expect(
      ClipCandidateSchema.safeParse({
        ...candidate,
        source: "manual",
        rank: null,
        potentialScore: null,
        scoreBreakdown: null,
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-range manual candidate requests and inverted materialized clips", () => {
    const request = ManualCandidateRequestSchema.parse(fixture("manual-candidate-request.v1.json"));
    const clip = RepurposeClipViewSchema.parse(fixture("clip-view.v1.json"));
    expect(
      ManualCandidateRequestSchema.safeParse({ ...request, endMs: request.startMs + 2_999 })
        .success,
    ).toBe(false);
    expect(
      RepurposeClipViewSchema.safeParse({ ...clip, sourceEndMs: clip.sourceStartMs }).success,
    ).toBe(false);
  });

  it("allows only stable, safe stage errors and prevents errors on successful stages", () => {
    const base = {
      schemaVersion: 1,
      runId: RUN_ID,
      stage: "getting_video",
      state: "failed",
      percent: 15,
      safeError: {
        code: SAFE_ERROR_CODES[2],
        message: "We could not get this video.",
        retryable: true,
      },
      updatedAt: "2026-09-15T00:00:00.000Z",
    };
    expect(StageProgressSchema.safeParse(base).success).toBe(true);
    expect(StageProgressSchema.safeParse({ ...base, safeError: null }).success).toBe(false);
    expect(StageProgressSchema.safeParse({ ...base, state: "complete" }).success).toBe(false);
    expect(
      StageProgressSchema.safeParse({
        ...base,
        safeError: { ...base.safeError, code: "provider/raw_exception" },
      }).success,
    ).toBe(false);
  });

  it("accepts an editor deep link and rejects an external link", () => {
    const view = {
      schemaVersion: 1,
      runId: RUN_ID,
      clipId: CLIP_ID,
      variantId: VARIANT_ID,
      projectId: PROJECT_ID,
      aspect: "9:16",
      status: "ready",
      editorHref: `/p/${PROJECT_ID}?returnTo=/repurpose/${RUN_ID}&variant=${VARIANT_ID}`,
      editFingerprint: "a".repeat(64),
      latestExportId: null,
      approvedAt: null,
    };
    expect(ClipVariantViewSchema.safeParse(view).success).toBe(true);
    expect(
      ClipVariantViewSchema.safeParse({ ...view, editorHref: "https://example.com/editor" })
        .success,
    ).toBe(false);
    expect(
      ClipVariantViewSchema.safeParse({
        ...view,
        editorHref: `/p/${PROJECT_ID}?returnTo=https://evil.example&variant=${VARIANT_ID}`,
      }).success,
    ).toBe(false);
  });
});
