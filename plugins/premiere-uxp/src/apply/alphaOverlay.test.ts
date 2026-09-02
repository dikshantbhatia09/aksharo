import { describe, expect, it } from "vitest";

import { placeAlphaOverlays } from "./alphaOverlay.js";
import { MockPremiereHost } from "../host/premiere.js";

describe("placeAlphaOverlays", () => {
  it("imports each asset to the bin and places it on the given track", async () => {
    const host = new MockPremiereHost();
    const placed = await placeAlphaOverlays(host, 4, [
      { segmentId: "seg-1", localPath: "/tmp/seg-1.mov", startFrames: 0, endFrames: 30 },
      { segmentId: "seg-2", localPath: "/tmp/seg-2.mov", startFrames: 30, endFrames: 60 },
    ]);

    expect(placed).toHaveLength(2);
    expect(placed[0]?.segmentId).toBe("seg-1");
    expect(placed[0]?.trackItemId).toMatch(/^track-item-/);
    expect(placed[1]?.binItemId).not.toBe(placed[0]?.binItemId);
  });
});
