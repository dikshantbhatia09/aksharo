import { describe, expect, it } from "vitest";

import type { ApplyPlanItem } from "@montaj/shared-apply";

import { applyAcceptedTitles } from "./titles.js";
import { MockPremiereHost } from "../host/premiere.js";

const FPS = 25;
const TITLE_MOGRT_PATH = "/mogrt/Aksharo Title.mogrt";

function titleItem(overrides: Partial<ApplyPlanItem> = {}): ApplyPlanItem {
  return {
    itemId: "title-1",
    passId: "pass-1",
    kind: "title",
    startMs: 500,
    endMs: 2500,
    state: "accepted",
    payload: {
      text: "Shipped in 3 days",
      intent: "hook",
      motionPreset: "slide-up",
      anchorWordIds: ["0:4"],
      layoutHint: {
        candidate: "upper-left",
        safeArea: { x: 40, y: 40, width: 1000, height: 400 },
      },
      styleRef: "style-hook-1",
    },
    ...overrides,
  };
}

describe("applyAcceptedTitles", () => {
  it("inserts a title MOGRT instance with the resolved param table", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedTitles(host, {
      projectId: "proj-1",
      items: [titleItem()],
      titleMogrtPath: TITLE_MOGRT_PATH,
      trackIndex: 3,
      fps: FPS,
    });

    expect(result.skipped).toEqual([]);
    expect(result.placed).toHaveLength(1);
    const placement = result.placed[0];
    if (!placement) throw new Error("expected one placed title");
    expect(placement).toMatchObject({ itemId: "title-1", via: "mogrt" });

    const params = await host.getMogrtParams(placement.trackItemId);
    expect(params).toMatchObject({
      Text: "Shipped in 3 days",
      MotionPreset: "slide-up",
      StyleId: "style-hook-1",
    });

    const metadata = await host.getItemMetadata(placement.trackItemId);
    expect(metadata).toEqual({ aksharo: { projectId: "proj-1", itemId: "title-1", rev: 0 } });
  });

  it("ignores non-accepted title items", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedTitles(host, {
      projectId: "proj-1",
      items: [titleItem({ state: "proposed" })],
      titleMogrtPath: TITLE_MOGRT_PATH,
      trackIndex: 3,
      fps: FPS,
    });
    expect(result.placed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("places multiple accepted titles independently", async () => {
    const host = new MockPremiereHost();
    const result = await applyAcceptedTitles(host, {
      projectId: "proj-1",
      items: [
        titleItem({ itemId: "title-a" }),
        titleItem({ itemId: "title-b", startMs: 3000, endMs: 4000 }),
      ],
      titleMogrtPath: TITLE_MOGRT_PATH,
      trackIndex: 3,
      fps: FPS,
    });
    expect(result.placed.map((p) => p.itemId)).toEqual(["title-a", "title-b"]);
    expect(result.placed.every((p) => p.via === "mogrt")).toBe(true);
  });

  // The `requiresOverlayFallback`/overlay-clip branch is unreachable today: every D06 preset
  // (`@montaj/shared-apply`'s `motionPresets.ts`) resolves to a supported param set, so no item
  // this WP can build ever sets that flag — see that module's doc comment for why the branch
  // still exists (a documented, honest "support today" state, not invented behaviour). It is
  // therefore not exercised here; a future preset that needs it should add the test alongside
  // whatever makes `requiresOverlayFallback` true for the first time.
});
