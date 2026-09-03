import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildApplyPlan } from "./planBuilder.js";

import type { ApplyPlanItem } from "./types.js";

// This package builds as CommonJS (matching `packages/timemap`'s convention, see
// `package.json`'s `"type": "commonjs"`), so `__dirname` is available and preferred over
// `import.meta.url` (disallowed by `tsc` for CJS output, TS1470).
const FIXTURE_PATH = join(__dirname, "..", "fixtures", "sample-items.json");
const GOLDEN_PATH = join(__dirname, "..", "fixtures", "sample-plan.json");

function loadItems(): ApplyPlanItem[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ApplyPlanItem[];
}

describe("buildApplyPlan", () => {
  it("only applies accepted items", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "i1",
        passId: "p1",
        kind: "cut",
        startMs: 0,
        endMs: 100,
        state: "proposed",
        payload: {},
      },
      {
        itemId: "i2",
        passId: "p1",
        kind: "cut",
        startMs: 200,
        endMs: 300,
        state: "rejected",
        payload: {},
      },
      {
        itemId: "i3",
        passId: "p1",
        kind: "cut",
        startMs: 400,
        endMs: 500,
        state: "modified",
        payload: {},
      },
    ];
    expect(buildApplyPlan(items)).toEqual({ ops: [], audioRefusals: [] });
  });

  it("emits a deleteRange op per accepted cut", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "i1",
        passId: "p1",
        kind: "cut",
        startMs: 0,
        endMs: 100,
        state: "accepted",
        payload: {},
      },
    ];
    expect(buildApplyPlan(items).ops).toEqual([
      { op: "deleteRange", itemId: "i1", startMs: 0, endMs: 100 },
    ]);
  });

  it("emits a motionKeyframes op per accepted zoom with decoded keyframes", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "z1",
        passId: "p1",
        kind: "zoom",
        startMs: 0,
        endMs: 1000,
        state: "accepted",
        payload: {},
        keyframes: [{ tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" }],
      },
    ];
    expect(buildApplyPlan(items).ops).toEqual([
      {
        op: "motionKeyframes",
        itemId: "z1",
        keyframes: [{ tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" }],
      },
    ]);
  });

  it("skips a zoom with no keyframes rather than emitting an empty op", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "z1",
        passId: "p1",
        kind: "zoom",
        startMs: 0,
        endMs: 1000,
        state: "accepted",
        payload: {},
      },
    ];
    expect(buildApplyPlan(items).ops).toEqual([]);
  });

  it("emits an audioClip op for an accepted, owned+panel-licensed sfx item", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "s1",
        passId: "p1",
        kind: "sfx",
        startMs: 1000,
        endMs: 1500,
        state: "accepted",
        payload: {
          assetId: "asset-1",
          packId: "pack-1",
          startMs: 1000,
          durationMs: 500,
          gainDb: -3,
          fadeInMs: 50,
          fadeOutMs: 50,
          duck: { depthDb: -6, attackMs: 20, releaseMs: 200 },
          licenceSnapshot: { allowsRawFileDelivery: true, surface: ["panel"] },
          cueReason: "whoosh",
        },
      },
    ];
    const plan = buildApplyPlan(items);
    expect(plan.audioRefusals).toEqual([]);
    expect(plan.ops).toEqual([
      {
        op: "audioClip",
        itemId: "s1",
        kind: "sfx",
        assetId: "asset-1",
        packId: "pack-1",
        startMs: 1000,
        durationMs: 500,
        gainDb: -3,
        fade: { fadeInMs: 50, fadeOutMs: 50 },
        duck: { depthDb: -6, attackMs: 20, releaseMs: 200 },
        loopPolicy: null,
        trackName: "Aksharo SFX",
      },
    ]);
  });

  it("refuses a partner-catalogue music item instead of emitting an op", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "m1",
        passId: "p1",
        kind: "music",
        startMs: 0,
        endMs: 5000,
        state: "accepted",
        payload: {
          assetId: "asset-2",
          packId: "pack-2",
          startMs: 0,
          durationMs: 5000,
          gainDb: -12,
          loopPolicy: "loop",
          bedDuck: null,
          licenceSnapshot: { allowsRawFileDelivery: false, surface: ["cloud_render"] },
          mood: "upbeat",
          bpm: 120,
        },
      },
    ];
    const plan = buildApplyPlan(items);
    expect(plan.ops).toEqual([]);
    expect(plan.audioRefusals).toEqual([
      {
        itemId: "m1",
        kind: "music",
        assetId: "asset-2",
        reasons: ["not-owned", "surface-not-allowed"],
        message:
          "This track is a partner-catalogue asset and can only be used in a cloud render, " +
          "not placed directly on the timeline.",
      },
    ]);
  });

  it("emits an audioClip op for an accepted, owned+panel-licensed music item", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "m2",
        passId: "p1",
        kind: "music",
        startMs: 0,
        endMs: 4000,
        state: "accepted",
        payload: {
          assetId: "asset-owned-bed-1",
          packId: "pack-tier0",
          startMs: 0,
          durationMs: 4000,
          gainDb: -10,
          loopPolicy: "trim",
          bedDuck: { depthDb: -6, attackMs: 25, releaseMs: 250 },
          licenceSnapshot: { allowsRawFileDelivery: true, surface: ["panel"] },
          mood: "calm",
          bpm: 100,
        },
      },
    ];
    const plan = buildApplyPlan(items);
    expect(plan.audioRefusals).toEqual([]);
    expect(plan.ops).toEqual([
      {
        op: "audioClip",
        itemId: "m2",
        kind: "music",
        assetId: "asset-owned-bed-1",
        packId: "pack-tier0",
        startMs: 0,
        durationMs: 4000,
        gainDb: -10,
        fade: { fadeInMs: 0, fadeOutMs: 0 },
        duck: { depthDb: -6, attackMs: 25, releaseMs: 250 },
        loopPolicy: "trim",
        trackName: "Aksharo Music",
      },
    ]);
  });

  it("emits a title op mapping motionPreset to the frozen param table", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "t1",
        passId: "p1",
        kind: "title",
        startMs: 0,
        endMs: 2000,
        state: "accepted",
        payload: {
          text: "42% growth",
          intent: "stat",
          motionPreset: "count-up",
          anchorWordIds: ["0:1"],
          layoutHint: {
            candidate: "top-third",
            safeArea: { x: 0, y: 0, width: 1080, height: 1920 },
          },
          styleRef: "style-1",
        },
      },
    ];
    const plan = buildApplyPlan(items);
    expect(plan.ops).toEqual([
      {
        op: "title",
        itemId: "t1",
        startMs: 0,
        endMs: 2000,
        text: "42% growth",
        motionPreset: "count-up",
        intent: "stat",
        layoutCandidate: "top-third",
        params: {
          Text: "42% growth",
          PositionY: 15,
          MotionPreset: "count-up",
          HighlightStart: 0,
          HighlightEnd: 100,
          StyleId: "style-1",
        },
        requiresOverlayFallback: false,
      },
    ]);
  });

  it("defaults a title's preset from its intent when motionPreset is absent", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "t2",
        passId: "p1",
        kind: "title",
        startMs: 0,
        endMs: 2000,
        state: "accepted",
        payload: { text: "Quote of the day" },
      },
    ];
    const [op] = buildApplyPlan(items).ops;
    expect(op).toMatchObject({ motionPreset: "pop", intent: "title" });
  });

  it("skips reframe items (owned by C06/C08's own apply mode)", () => {
    const items: ApplyPlanItem[] = [
      {
        itemId: "r1",
        passId: "p1",
        kind: "reframe",
        startMs: 0,
        endMs: 100,
        state: "accepted",
        payload: {},
      },
    ];
    expect(buildApplyPlan(items).ops).toEqual([]);
  });

  // Parity fixture (D09 brief §Scope 3): the same fixture file this test loads is read by
  // `plugins/resolve/tests/test_apply_plan_parity.py`'s Python dataclasses, proving one EDG
  // state produces a structurally equivalent plan on both plugin runtimes.
  it("matches the checked-in golden plan for the shared fixture (TS/Python parity source)", () => {
    const items = loadItems();
    const plan = buildApplyPlan(items);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
    expect(plan).toEqual(golden);
  });
});
