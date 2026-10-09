import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  HighlightsPayloadSchema,
  HighlightsResultSchema,
  MEDIA_CLIP_PAYLOAD_FIELDS,
  MediaAcquirePayloadSchema,
  MediaAcquireResultSchema,
  MediaClipPayloadSchema,
  MediaClipResultSchema,
  clipMasterKey,
  highlightsJobKey,
  layoutKeySuffix,
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
  "copy",
  "diagnostic",
  "endMs",
  "endWordId",
  "judgement",
  "potentialScore",
  "reasons",
  "scoreBreakdown",
  "startMs",
  "startWordId",
  "tier",
  "title",
  "transcriptExcerpt",
  "windowId",
];

describe("media.acquire@1", () => {
  it("accepts the documented payload and result", () => {
    expect(
      MediaAcquirePayloadSchema.safeParse(fixture("media-acquire-payload.v1.json")).success,
    ).toBe(true);
    expect(
      MediaAcquireResultSchema.safeParse(fixture("media-acquire-result.v1.json")).success,
    ).toBe(true);
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
    expect(MediaClipResultSchema.safeParse(fixture("media-clip-result.v1.json")).success).toBe(
      true,
    );
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

describe("media.clip@1, two-speaker layouts (2026-10-01)", () => {
  const stacked = fixture("media-clip-payload-stacked.v1.json");
  const reframe = stacked["reframe"] as Record<string, unknown>;

  it("accepts a stacked cut naming its two people, top first", () => {
    const parsed = MediaClipPayloadSchema.parse(stacked);
    expect(parsed.reframe?.layout).toBe("stacked");
    expect(parsed.reframe?.people?.map((person) => person.centerX)).toEqual([0.3, 0.72]);
    // A 4:5 cut may be stacked too.
    expect(MediaClipPayloadSchema.safeParse({ ...stacked, aspect: "4:5" }).success).toBe(true);
  });

  it("still accepts every payload from before: no layout is one window", () => {
    const { layout: _layout, people: _people, ...single } = reframe;
    expect(MediaClipPayloadSchema.safeParse({ ...stacked, reframe: single }).success).toBe(true);
    expect(
      MediaClipPayloadSchema.safeParse({
        ...stacked,
        reframe: { ...single, layout: "single" },
      }).success,
    ).toBe(true);
  });

  it("refuses a stack without exactly two people, and people without a stack", () => {
    const people = reframe["people"] as unknown[];
    for (const broken of [
      { ...reframe, people: undefined },
      { ...reframe, people: people.slice(0, 1) },
      { ...reframe, people: [...people, people[0]] },
      { ...reframe, layout: "single" },
      { ...reframe, people: [{ centerX: 0.3, centerY: 0.4, size: 0 }, people[1]] },
      { ...reframe, people: [{ centerX: 1.3, centerY: 0.4, size: 0.1 }, people[1]] },
    ]) {
      expect(MediaClipPayloadSchema.safeParse({ ...stacked, reframe: broken }).success).toBe(false);
    }
  });

  it("refuses a stacked square or landscape cut", () => {
    for (const aspect of ["1:1", "16:9"]) {
      expect(MediaClipPayloadSchema.safeParse({ ...stacked, aspect }).success).toBe(false);
    }
  });

  it("names a stacked cut in its key, and leaves a one-window key as it always was", () => {
    expect(mediaClipJobKey(CANDIDATE, "0-1", "3", "stacked")).toBe(
      `media.clip:${CANDIDATE}:0-1:3:stacked`,
    );
    expect(mediaClipJobKey(CANDIDATE, "0-1", "3", "single")).toBe(`media.clip:${CANDIDATE}:0-1:3`);
    expect(mediaClipJobKey(CANDIDATE, "0-1", "3")).toBe(mediaClipJobKey(CANDIDATE, "0-1", "3"));
    expect(layoutKeySuffix("stacked")).toBe(":stacked");
    expect(layoutKeySuffix("fit")).toBe(":fit");
    expect(layoutKeySuffix("single")).toBe("");
    expect(mediaClipJobKey(CANDIDATE, "0-1", "3", "fit")).toBe(`media.clip:${CANDIDATE}:0-1:3:fit`);
  });
});

describe("media.clip@1, dynamic reframe trajectory (Pillar 3 §01)", () => {
  const basePayload = fixture("media-clip-payload.v1.json");
  const validTrajectory = {
    interpolation: "SPRING_DAMPED" as const,
    keyframes: [
      { timeSec: 0, centerX: 0.25, centerY: 0.4, zoom: 1 },
      { timeSec: 1.5, centerX: 0.52, centerY: 0.4, zoom: 1.08 },
      { timeSec: 4.0, centerX: 0.75, centerY: 0.42, zoom: 1 },
    ],
  };

  it("accepts a single-speaker reframe carrying a time-varying trajectory", () => {
    const parsed = MediaClipPayloadSchema.parse({
      ...basePayload,
      reframe: {
        centerX: 0.5,
        centerY: 0.4,
        basis: "faces",
        trajectory: validTrajectory,
      },
    });
    expect(parsed.reframe?.trajectory?.interpolation).toBe("SPRING_DAMPED");
    expect(parsed.reframe?.trajectory?.keyframes).toHaveLength(3);
  });

  it("refuses out-of-order keyframes, out-of-range coordinates/zoom, or trajectory on a stacked cut", () => {
    const stacked = fixture("media-clip-payload-stacked.v1.json");
    const stackedReframe = stacked["reframe"] as Record<string, unknown>;
    expect(
      MediaClipPayloadSchema.safeParse({
        ...stacked,
        reframe: { ...stackedReframe, trajectory: validTrajectory },
      }).success,
    ).toBe(false);

    for (const invalidTrajectory of [
      {
        interpolation: "SPRING_DAMPED",
        keyframes: [
          { timeSec: 2.0, centerX: 0.3, centerY: 0.4, zoom: 1 },
          { timeSec: 1.0, centerX: 0.7, centerY: 0.4, zoom: 1 },
        ],
      },
      {
        interpolation: "CUBIC_BEZIER",
        keyframes: [{ timeSec: 0, centerX: 1.2, centerY: 0.4, zoom: 1 }],
      },
      {
        interpolation: "CUBIC_BEZIER",
        keyframes: [{ timeSec: 0, centerX: 0.5, centerY: 0.4, zoom: 1.8 }],
      },
    ]) {
      expect(
        MediaClipPayloadSchema.safeParse({
          ...basePayload,
          reframe: { centerX: 0.5, basis: "faces", trajectory: invalidTrajectory },
        }).success,
      ).toBe(false);
    }
  });
});

describe("media.clip@1, audiograms (2026-10-04)", () => {
  const payload = fixture("media-clip-payload-audiogram.v1.json");
  const audiogram = payload["audiogram"] as Record<string, unknown>;

  it("accepts a cut that draws a picture for a source with none, and its result", () => {
    const parsed = MediaClipPayloadSchema.parse(payload);
    expect(parsed.audiogram).toEqual({
      background: "#141217",
      accent: "#f0508a",
      artwork: {
        key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/brand/01ARZ3NDEKTSV4RRFFQ69G5FC1.jpg",
        format: "jpeg",
      },
    });
    // Without artwork: a waveform on the ground alone.
    const { artwork: _artwork, ...bare } = audiogram;
    expect(MediaClipPayloadSchema.safeParse({ ...payload, audiogram: bare }).success).toBe(true);

    const result = MediaClipResultSchema.parse(fixture("media-clip-result-audiogram.v1.json"));
    expect(result.picture).toBe("audiogram");
    expect(MediaClipResultSchema.safeParse({ ...result, picture: "source" }).success).toBe(true);
  });

  it("still accepts every payload and result from before: no audiogram, no picture", () => {
    const { audiogram: _dropped, ...before } = payload;
    expect(MediaClipPayloadSchema.safeParse(before).success).toBe(true);
    expect(
      MediaClipResultSchema.parse(fixture("media-clip-result.v1.json")).picture,
    ).toBeUndefined();
  });

  it("refuses a colour that is not #RRGGBB, since it reaches a filtergraph", () => {
    for (const colour of ["red", "#fff", "#12345G", "#123456;drawbox", "0x141217", ""]) {
      expect(
        MediaClipPayloadSchema.safeParse({
          ...payload,
          audiogram: { ...audiogram, background: colour },
        }).success,
        colour,
      ).toBe(false);
      expect(
        MediaClipPayloadSchema.safeParse({
          ...payload,
          audiogram: { ...audiogram, accent: colour },
        }).success,
        colour,
      ).toBe(false);
    }
  });

  it("refuses artwork from another workspace, a traversal, or a type it cannot draw", () => {
    const artwork = audiogram["artwork"] as Record<string, unknown>;
    for (const broken of [
      { ...artwork, key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FZZ/brand/01ARZ3NDEKTSV4RRFFQ69G5FC1.jpg" },
      { ...artwork, key: "ws/01ARZ3NDEKTSV4RRFFQ69G5FB0/../../x.jpg" },
      { ...artwork, key: "https://example.test/cover.jpg" },
      { ...artwork, format: "gif" },
      { ...artwork, extra: true },
    ]) {
      expect(
        MediaClipPayloadSchema.safeParse({
          ...payload,
          audiogram: { ...audiogram, artwork: broken },
        }).success,
        JSON.stringify(broken),
      ).toBe(false);
    }
  });

  it("refuses a stacked audiogram and an unknown audiogram field", () => {
    const stacked = fixture("media-clip-payload-stacked.v1.json");
    expect(
      MediaClipPayloadSchema.safeParse({
        ...stacked,
        audiogram: { ...audiogram, artwork: undefined },
      }).success,
    ).toBe(false);
    expect(
      MediaClipPayloadSchema.safeParse({ ...payload, audiogram: { ...audiogram, style: "bars" } })
        .success,
    ).toBe(false);
  });

  it("lists exactly the payload's fields, for the worker's restatement to be held to", () => {
    expect([...MEDIA_CLIP_PAYLOAD_FIELDS].sort()).toEqual([...MEDIA_CLIP_PAYLOAD_FIELDS]);
    expect(Object.keys(MediaClipPayloadSchema.shape).sort()).toEqual([
      ...MEDIA_CLIP_PAYLOAD_FIELDS,
    ]);
  });
});

describe("ai.highlights@1", () => {
  it("accepts the documented payload and result", () => {
    expect(
      HighlightsPayloadSchema.safeParse(fixture("ai-highlights-payload.v1.json")).success,
    ).toBe(true);
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
      expect(
        HighlightsResultSchema.safeParse({ ...result, proposals }).success,
        String(endMs),
      ).toBe(false);
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

  it("carries the workspace's region for the language model, and nothing but a region", () => {
    const payload = fixture("ai-highlights-payload.v1.json");
    for (const region of ["in", "eu", "us"]) {
      const options = { ...(payload["options"] as object), region };
      expect(HighlightsPayloadSchema.safeParse({ ...payload, options }).success, region).toBe(true);
    }
    const options = { ...(payload["options"] as object), region: "mars" };
    expect(HighlightsPayloadSchema.safeParse({ ...payload, options }).success).toBe(false);
  });

  it("accepts hashtags in Devanagari, vowel signs and all, and nothing with a space", () => {
    const result = fixture("ai-highlights-result.v1.json") as { proposals: object[] };
    const withTags = (hashtags: string[]) => ({
      ...result,
      proposals: result.proposals.map((proposal) => ({
        ...proposal,
        copy: { summary: "", hook: "", cta: "", hashtags, locale: "hi" },
      })),
    });
    expect(
      HighlightsResultSchema.safeParse(withTags(["#हिंदी", "#पैसा", "#money_tips"])).success,
    ).toBe(true);
    expect(HighlightsResultSchema.safeParse(withTags(["#money tips"])).success).toBe(false);
    expect(HighlightsResultSchema.safeParse(withTags(["money"])).success).toBe(false);
  });

  it("carries a workspace's track record, and the reason it adds (2026-10-05)", () => {
    const payload = HighlightsPayloadSchema.parse(
      fixture("ai-highlights-payload-performance.v1.json"),
    );
    expect(payload.options.performance).toMatchObject({
      basis: 14,
      length: { minMs: 20_000, maxMs: 40_000, posts: 7 },
      hook: { style: "question", posts: 6 },
    });
    expect(payload.options.performance?.hits).toHaveLength(2);
    // Nothing but the performance option differs from the documented payload.
    expect(Object.keys(payload).sort()).toEqual(HIGHLIGHTS_PAYLOAD_FIELDS);

    const result = HighlightsResultSchema.parse(
      fixture("ai-highlights-result-performance.v1.json"),
    );
    expect(result.proposals[0]?.reasons.map((reason) => reason.label)).toContain("track_record");
    const source = fixture("ai-highlights-result-performance.v1.json");
    expect(JSON.parse(JSON.stringify(HighlightsResultSchema.parse(source)))).toEqual(source);
  });

  it("holds the track record to its bounds", () => {
    const payload = fixture("ai-highlights-payload-performance.v1.json");
    const options = payload["options"] as Record<string, unknown>;
    const performance = options["performance"] as Record<string, unknown>;
    const withPerformance = (change: Record<string, unknown>) => ({
      ...payload,
      options: { ...options, performance: { ...performance, ...change } },
    });
    const hit = { title: "A clip", views: 10, platform: "youtube" };
    for (const change of [
      { hits: Array.from({ length: 6 }, () => hit) },
      { hits: [{ ...hit, platform: "myspace" }] },
      { hits: [{ ...hit, views: -1 }] },
      { hits: [{ ...hit, extra: true }] },
      { length: { minMs: 40_000, maxMs: 20_000, posts: 5 } },
      { length: { minMs: 0, maxMs: 400_000, posts: 5 } },
      { hook: { style: "shouting", posts: 5 } },
      { basis: 0 },
      { weight: 2 },
    ]) {
      expect(
        HighlightsPayloadSchema.safeParse(withPerformance(change)).success,
        JSON.stringify(change),
      ).toBe(false);
    }
    expect(
      HighlightsPayloadSchema.safeParse(withPerformance({ hits: [], length: undefined })).success,
    ).toBe(true);
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

    expect(features).toBe(`ws/${WORKSPACE}/p/${PROJECT}/repurpose/${RUN}/features/features-1.json`);
    expect(master).toBe(
      `ws/${WORKSPACE}/p/${PROJECT}/repurpose/${RUN}/clips/${CANDIDATE}/master.mp4`,
    );
    for (const key of [features, master]) {
      expect(key.startsWith(`ws/${WORKSPACE}/`)).toBe(true);
      expect(key).not.toContain("..");
    }
  });
});
