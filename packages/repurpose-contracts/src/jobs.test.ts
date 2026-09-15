import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HighlightsPayloadSchema,
  HighlightsResultSchema,
  MediaAcquirePayloadSchema,
  MediaAcquireResultSchema,
  MediaClipPayloadSchema,
  MediaClipResultSchema,
  clipMasterKey,
  highlightsJobKey,
  mediaAcquireJobKey,
  mediaClipJobKey,
  repurposeFeaturesKey,
} from "./jobs.js";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

const WORKSPACE = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CANDIDATE = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

/**
 * The `ai.highlights@1` field lists, written out.
 *
 * `apps/worker-ai/tests/test_highlight_contracts.py` asserts the SAME literals
 * against the same fixtures. That is the parity guard REP-005 asks for: adding a
 * field on one side without the other fails here or there, rather than being
 * silently dropped between the API and the Python worker.
 */
const HIGHLIGHTS_PAYLOAD_FIELDS = [
  "featureVersion",
  "options",
  "projectId",
  "promptVersion",
  "proxy",
  "runId",
  "schemaVersion",
  "transcriptId",
  "transcriptRevision",
  "waveform",
];
const HIGHLIGHTS_RESULT_FIELDS = [
  "featureVersion",
  "model",
  "promptVersion",
  "proposals",
  "runId",
  "schemaVersion",
  "transcriptId",
  "transcriptRevision",
  "windowsConsidered",
];
const HIGHLIGHT_PROPOSAL_FIELDS = [
  "endMs",
  "endWordId",
  "potentialScore",
  "reasons",
  "scoreBreakdown",
  "startMs",
  "startWordId",
  "title",
  "transcriptExcerpt",
  "windowId",
];

describe("media.acquire@1", () => {
  it("accepts the documented payload and result", () => {
    expect(MediaAcquirePayloadSchema.safeParse(fixture("media-acquire-payload.v1.json")).success).toBe(
      true,
    );
    expect(MediaAcquireResultSchema.safeParse(fixture("media-acquire-result.v1.json")).success).toBe(
      true,
    );
  });

  it("refuses a source that is not HTTPS", () => {
    const payload = fixture("media-acquire-payload.v1.json");
    const source = { ...(payload["source"] as object), normalizedUrl: "http://example.test/v.mp4" };
    expect(MediaAcquirePayloadSchema.safeParse({ ...payload, source }).success).toBe(false);
  });

  it("refuses a destination key that traverses out of the workspace prefix", () => {
    const payload = fixture("media-acquire-payload.v1.json");
    for (const key of [
      "ws/a/p/b/../../../etc/passwd",
      "/absolute/key.mp4",
      "ws\\a\\p\\b\\raw.mp4",
      "",
    ]) {
      expect(
        MediaAcquirePayloadSchema.safeParse({
          ...payload,
          destination: { bucket: "s3", key },
        }).success,
        key,
      ).toBe(false);
    }
  });

  it("refuses an unbounded download", () => {
    const payload = fixture("media-acquire-payload.v1.json");
    const limits = { ...(payload["limits"] as object), maxBytes: 0 };
    expect(MediaAcquirePayloadSchema.safeParse({ ...payload, limits }).success).toBe(false);
  });

  it("keys the job on the source, so ten pastes are one download", () => {
    expect(mediaAcquireJobKey(RUN, "youtube:abc")).toBe(`media.acquire:${RUN}:youtube:abc`);
    expect(mediaAcquireJobKey(RUN, "youtube:abc")).toBe(mediaAcquireJobKey(RUN, "youtube:abc"));
    expect(mediaAcquireJobKey(RUN, "youtube:abc")).not.toBe(mediaAcquireJobKey(RUN, "youtube:xyz"));
  });
});

describe("media.clip@1", () => {
  it("accepts the documented payload and result", () => {
    expect(MediaClipPayloadSchema.safeParse(fixture("media-clip-payload.v1.json")).success).toBe(
      true,
    );
    expect(MediaClipResultSchema.safeParse(fixture("media-clip-result.v1.json")).success).toBe(true);
  });

  it("refuses bounds that run backwards or past the end of the source", () => {
    const payload = fixture("media-clip-payload.v1.json");
    expect(
      MediaClipPayloadSchema.safeParse({ ...payload, startMs: 360_000, endMs: 330_000 }).success,
    ).toBe(false);
    expect(MediaClipPayloadSchema.safeParse({ ...payload, endMs: 2_000_000 }).success).toBe(false);
  });

  it("refuses a result whose effective bounds run backwards", () => {
    const result = fixture("media-clip-result.v1.json");
    expect(
      MediaClipResultSchema.safeParse({ ...result, effectiveEndMs: 1, effectiveStartMs: 2 })
        .success,
    ).toBe(false);
  });

  it("puts the bounds and the profile in the key, so a re-trim is new work", () => {
    expect(mediaClipJobKey(CANDIDATE, "abc123", "mezzanine-1")).toBe(
      `media.clip:${CANDIDATE}:abc123:mezzanine-1`,
    );
    expect(mediaClipJobKey(CANDIDATE, "abc123", "mezzanine-1")).not.toBe(
      mediaClipJobKey(CANDIDATE, "def456", "mezzanine-1"),
    );
    expect(mediaClipJobKey(CANDIDATE, "abc123", "mezzanine-1")).not.toBe(
      mediaClipJobKey(CANDIDATE, "abc123", "mezzanine-2"),
    );
  });
});

describe("ai.highlights@1", () => {
  it("accepts the documented payload and result", () => {
    expect(HighlightsPayloadSchema.safeParse(fixture("ai-highlights-payload.v1.json")).success).toBe(
      true,
    );
    expect(HighlightsResultSchema.safeParse(fixture("ai-highlights-result.v1.json")).success).toBe(
      true,
    );
  });

  it("has exactly the fields the Python mirror declares", () => {
    const payload = HighlightsPayloadSchema.parse(fixture("ai-highlights-payload.v1.json"));
    expect(Object.keys(payload).sort()).toEqual(HIGHLIGHTS_PAYLOAD_FIELDS);

    const result = HighlightsResultSchema.parse(fixture("ai-highlights-result.v1.json"));
    expect(Object.keys(result).sort()).toEqual(HIGHLIGHTS_RESULT_FIELDS);
    expect(Object.keys(result.proposals[0] ?? {}).sort()).toEqual(HIGHLIGHT_PROPOSAL_FIELDS);
  });

  it("round-trips the result fixture unchanged", () => {
    const source = fixture("ai-highlights-result.v1.json");
    expect(JSON.parse(JSON.stringify(HighlightsResultSchema.parse(source)))).toEqual(source);
  });

  it("refuses a proposal without a window id, because the model must choose one", () => {
    const result = fixture("ai-highlights-result.v1.json") as { proposals: object[] };
    const proposals = result.proposals.map((proposal) => {
      const { windowId: _dropped, ...rest } = proposal as { windowId: string };
      return rest;
    });
    expect(HighlightsResultSchema.safeParse({ ...result, proposals }).success).toBe(false);
  });

  it("refuses a proposal with no reason, because a score alone explains nothing", () => {
    const result = fixture("ai-highlights-result.v1.json") as { proposals: object[] };
    const proposals = result.proposals.map((proposal) => ({ ...proposal, reasons: [] }));
    expect(HighlightsResultSchema.safeParse({ ...result, proposals }).success).toBe(false);
  });

  it("refuses a proposal outside the hard duration limits", () => {
    const result = fixture("ai-highlights-result.v1.json") as { proposals: object[] };
    for (const endMs of [330_500, 600_000]) {
      const proposals = result.proposals.map((proposal) => ({ ...proposal, endMs }));
      expect(HighlightsResultSchema.safeParse({ ...result, proposals }).success, String(endMs)).toBe(
        false,
      );
    }
  });

  it("accepts an empty proposal list rather than requiring padding", () => {
    const result = fixture("ai-highlights-result.v1.json");
    expect(HighlightsResultSchema.safeParse({ ...result, proposals: [] }).success).toBe(true);
  });

  it("refuses a minimum duration above the maximum", () => {
    const payload = fixture("ai-highlights-payload.v1.json");
    const options = { ...(payload["options"] as object), minDurationMs: 90_000 };
    expect(HighlightsPayloadSchema.safeParse({ ...payload, options }).success).toBe(false);
  });

  it("puts the transcript revision in the key, so an edit re-analyses", () => {
    expect(highlightsJobKey(RUN, "T1", 3, "cfg")).toBe(`ai.highlights:${RUN}:T1:3:cfg`);
    expect(highlightsJobKey(RUN, "T1", 3, "cfg")).not.toBe(highlightsJobKey(RUN, "T1", 4, "cfg"));
  });
});

describe("storage keys", () => {
  it("keeps every repurposing artefact under the source project's workspace prefix", () => {
    const features = repurposeFeaturesKey({
      workspaceId: WORKSPACE,
      sourceProjectId: PROJECT,
      runId: RUN,
      featureVersion: "features-1",
    });
    const master = clipMasterKey({
      workspaceId: WORKSPACE,
      sourceProjectId: PROJECT,
      runId: RUN,
      candidateId: CANDIDATE,
    });

    expect(features).toBe(
      `ws/${WORKSPACE}/p/${PROJECT}/repurpose/${RUN}/features/features-1.json`,
    );
    expect(master).toBe(`ws/${WORKSPACE}/p/${PROJECT}/repurpose/${RUN}/clips/${CANDIDATE}/master.mp4`);
    for (const key of [features, master]) {
      expect(key.startsWith(`ws/${WORKSPACE}/`)).toBe(true);
      expect(key).not.toContain("..");
    }
  });
});
