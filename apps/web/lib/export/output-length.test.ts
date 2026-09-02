/**
 * B20: the output-length verification B18 left undone — accepted `cut` pass
 * items projected all the way to the manifest's `outputDurationMs`, the number
 * `runExport` sizes its frame loop from (`totalFrames` in `engine.ts`).
 *
 * `timemap-adapter.test.ts` already proves a manifest's own `timemap.edits`
 * shorten `outputDurationMsFor`; this test proves the step before that one —
 * that only `accepted` pass items (never `proposed`/`rejected`/`modified`)
 * contribute a cut, exactly as a reviewer would expect after using the Passes
 * tab — using `@montaj/timemap`'s `fromAcceptedItems`, the function
 * `apps/api/src/exports/exports.service.ts` calls to build the timemap this
 * manifest's `timemap.edits` come from.
 */
import { describe, expect, it } from "vitest";

import type { PassItem } from "@montaj/edg";
import { fromAcceptedItems } from "@montaj/timemap";

function cutItem(itemId: string, startMs: number, endMs: number, state: PassItem["state"]): PassItem {
  return {
    itemId,
    passId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
    kind: "cut",
    startMs,
    endMs,
    payload: {},
    state,
  };
}

describe("accepted cuts → projected output length", () => {
  it("only accepted cut items shorten the output", () => {
    const items: PassItem[] = [
      cutItem("i1", 1_000, 2_000, "accepted"), // 1000ms removed
      cutItem("i2", 3_000, 3_500, "rejected"), // ignored
      cutItem("i3", 5_000, 5_800, "proposed"), // ignored — not yet decided
      cutItem("i4", 7_000, 7_200, "modified"), // ignored — open review decision
      cutItem("i5", 8_000, 9_000, "accepted"), // 1000ms removed
    ];
    const timeMap = fromAcceptedItems(items, { sourceDurationMs: 10_000 });
    expect(timeMap.outputDurationMs).toBe(10_000 - 1_000 - 1_000);
  });

  it("matches exactly when every item is decided the same way", () => {
    const allAccepted = fromAcceptedItems(
      [cutItem("a", 0, 500, "accepted"), cutItem("b", 9_500, 10_000, "accepted")],
      { sourceDurationMs: 10_000 },
    );
    expect(allAccepted.outputDurationMs).toBe(9_000);

    const allRejected = fromAcceptedItems(
      [cutItem("a", 0, 500, "rejected"), cutItem("b", 9_500, 10_000, "rejected")],
      { sourceDurationMs: 10_000 },
    );
    expect(allRejected.outputDurationMs).toBe(10_000);
  });

  it("merges overlapping accepted cuts from two different passes", () => {
    const items: PassItem[] = [
      cutItem("p1-a", 1_000, 3_000, "accepted"),
      cutItem("p2-a", 2_000, 4_000, "accepted"),
    ];
    const timeMap = fromAcceptedItems(items, { sourceDurationMs: 10_000 });
    // Merged to one [1000, 4000) cut, not double-counted.
    expect(timeMap.outputDurationMs).toBe(7_000);
  });

  it("non-cut item kinds (zoom, reframe, sfx, music, title) never shorten the output", () => {
    const items: PassItem[] = [
      {
        itemId: "z1",
        passId: "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        kind: "zoom",
        startMs: 1_000,
        endMs: 2_000,
        payload: { target: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, scaleFrom: 1, scaleTo: 1.5, easing: "easeInOut" },
        state: "accepted",
      },
    ];
    const timeMap = fromAcceptedItems(items, { sourceDurationMs: 10_000 });
    expect(timeMap.outputDurationMs).toBe(10_000);
  });
});
