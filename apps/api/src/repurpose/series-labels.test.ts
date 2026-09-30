import { describe, expect, it } from "vitest";

import { MAX_OVERLAYS } from "@montaj/edg";
import type { HookTitleOverlay, Overlay, PassItem } from "@montaj/edg/schemas";

import {
  SERIES_LABEL_MS,
  hookOverlayOf,
  nextText,
  partText,
  planLabelRemoval,
  planSeriesLabels,
  seriesLabelIds,
} from "./series-labels.js";

const VARIANT = "01JCVAR1ANT000000000000000";
const IDS = seriesLabelIds(VARIANT);
const BRAND = { fontFamily: "Poppins", background: "#f0508a", text: "#0b0a0c" };

const autopilotHook: HookTitleOverlay = {
  id: VARIANT,
  kind: "hook-title",
  text: "Paisa bachana easy hai",
  startMs: 0,
  endMs: 2_500,
  appearance: BRAND,
};

function cut(startMs: number, endMs: number): PassItem {
  return {
    itemId: `01JCCUT${String(startMs).padStart(19, "0")}`,
    passId: "01JCPASS000000000000000000",
    kind: "cut",
    startMs,
    endMs,
    payload: {},
    state: "accepted",
  } as PassItem;
}

function ownHook(id: string, startMs: number, endMs: number): Overlay {
  return { id, kind: "hook-title", text: "Mine", startMs, endMs };
}

describe("the label words", () => {
  it("says which part, and which comes next", () => {
    expect(partText(2, 4)).toBe("Part 2 of 4");
    expect(nextText(2)).toBe("Part 3 next");
  });

  it("names a shape's labels the same on every ask", () => {
    expect(seriesLabelIds(VARIANT)).toEqual(IDS);
    expect(IDS.part).not.toBe(IDS.next);
    expect(IDS.part).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("planSeriesLabels (2026-10-03)", () => {
  it("replaces Autopilot's hook with the part label, in its look, and adds what comes next", () => {
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 2,
      parts: 3,
      overlays: [autopilotHook],
      items: [],
      durationMs: 30_000,
    });
    expect(plan.replaced).toEqual(autopilotHook);
    expect(plan.added).toEqual([IDS.part, IDS.next]);
    expect(plan.ops.map((op) => op.type)).toEqual(["RemoveOverlay", "SetOverlay", "SetOverlay"]);
    expect(plan.ops[0]).toMatchObject({ overlayId: VARIANT });
    expect(plan.ops[1]).toMatchObject({
      overlay: {
        id: IDS.part,
        kind: "hook-title",
        text: "Part 2 of 3",
        startMs: 0,
        endMs: SERIES_LABEL_MS,
        appearance: BRAND,
      },
    });
    expect(plan.ops[2]).toMatchObject({
      overlay: { id: IDS.next, text: "Part 3 next", startMs: 28_000, endMs: 30_000 },
    });
  });

  it("puts nothing next on the last part", () => {
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 3,
      parts: 3,
      overlays: [],
      items: [],
      durationMs: 30_000,
    });
    expect(plan.added).toEqual([IDS.part]);
    expect(plan.replaced).toBeNull();
    expect(plan.ops).toHaveLength(1);
  });

  it("times the labels on the video as it plays, after its cuts", () => {
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 1,
      parts: 2,
      overlays: [],
      // The first second is cut, and a second in the middle.
      items: [cut(0, 1_000), cut(10_000, 11_000)],
      durationMs: 30_000,
    });
    expect(plan.ops[0]).toMatchObject({ overlay: { startMs: 1_000, endMs: 3_000 } });
    expect(plan.ops[1]).toMatchObject({ overlay: { startMs: 28_000, endMs: 30_000 } });
  });

  it("puts what comes next before a brand end card, never over it", () => {
    const card: Overlay = {
      id: "01JCCARD000000000000000000",
      kind: "end-card",
      startMs: 27_000,
      endMs: 30_000,
      background: "#141217",
    };
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 1,
      parts: 2,
      overlays: [card],
      items: [],
      durationMs: 30_000,
    });
    expect(plan.ops.at(-1)).toMatchObject({ overlay: { startMs: 25_000, endMs: 27_000 } });
  });

  it("never touches a title the person wrote: a label over it is left off", () => {
    const mine = ownHook("01JCM1NE000000000000000000", 0, 2_500);
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 1,
      parts: 2,
      overlays: [mine],
      items: [],
      durationMs: 30_000,
    });
    expect(plan.added).toEqual([IDS.next]);
    expect(plan.ops.every((op) => op.type === "SetOverlay")).toBe(true);
    expect(plan.replaced).toBeNull();
  });

  it("leaves off what comes next when the clip is too short to hold both", () => {
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 1,
      parts: 2,
      overlays: [],
      items: [],
      durationMs: 3_000,
    });
    expect(plan.added).toEqual([IDS.part]);
  });

  it("keeps within the document's overlays, dropping what comes next first", () => {
    // A full document, whatever the cap is (8 until B-roll, 16 since).
    const others: Overlay[] = [
      autopilotHook,
      ...Array.from({ length: MAX_OVERLAYS - 1 }, (_, index) =>
        ownHook(
          `01JCM1NE${String(index).padStart(18, "0")}`,
          5_000 + index * 2_000,
          6_000 + index * 2_000,
        ),
      ),
    ];
    const plan = planSeriesLabels({
      variantId: VARIANT,
      part: 1,
      parts: 2,
      overlays: others,
      items: [],
      durationMs: 60_000,
    });
    // The part label takes Autopilot's place; there is no room for one more.
    expect(plan.added).toEqual([IDS.part]);
  });

  it("plans nothing for a shape with no media", () => {
    expect(
      planSeriesLabels({
        variantId: VARIANT,
        part: 1,
        parts: 2,
        overlays: [],
        items: [],
        durationMs: 0,
      }),
    ).toEqual({ ops: [], replaced: null, added: [] });
  });
});

describe("planLabelRemoval", () => {
  const partLabel: Overlay = {
    id: IDS.part,
    kind: "hook-title",
    text: "Part 1 of 2",
    startMs: 0,
    endMs: 2_000,
  };
  const nextLabel: Overlay = {
    id: IDS.next,
    kind: "hook-title",
    text: "Part 2 next",
    startMs: 28_000,
    endMs: 30_000,
  };

  it("takes the labels off and puts Autopilot's hook back", () => {
    const ops = planLabelRemoval({
      added: [IDS.part, IDS.next],
      replaced: autopilotHook,
      overlays: [partLabel, nextLabel],
    });
    expect(ops.map((op) => op.type)).toEqual(["RemoveOverlay", "RemoveOverlay", "SetOverlay"]);
    expect(ops[2]).toMatchObject({ overlay: autopilotHook });
  });

  it("keeps a title the person wrote since, and takes off only labels still there", () => {
    const mine = ownHook("01JCM1NE000000000000000000", 0, 1_500);
    const ops = planLabelRemoval({
      added: [IDS.part, IDS.next],
      replaced: autopilotHook,
      overlays: [mine, nextLabel],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ type: "RemoveOverlay", overlayId: IDS.next });
  });

  it("reads a stored hook back, and nothing else", () => {
    expect(hookOverlayOf(autopilotHook)).toEqual(autopilotHook);
    expect(hookOverlayOf({ ...autopilotHook, kind: "logo" })).toBeNull();
    expect(hookOverlayOf(null)).toBeNull();
  });
});
