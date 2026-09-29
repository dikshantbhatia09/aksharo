import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_MAX_CLIPS,
  AUTOPILOT_MIN_ASKED,
  autopilotClipCount,
} from "./repurpose.constants.js";

describe("autopilotClipCount — how many moments Autopilot asks for", () => {
  it("asks for about one per two minutes of processed video", () => {
    expect(autopilotClipCount(60 * 60_000)).toBe(30);
    expect(autopilotClipCount(35 * 60_000)).toBe(18);
  });

  it("never asks for fewer than five, or more than forty", () => {
    expect(autopilotClipCount(3 * 60_000)).toBe(AUTOPILOT_MIN_ASKED);
    expect(autopilotClipCount(null)).toBe(AUTOPILOT_MIN_ASKED);
    expect(autopilotClipCount(6 * 60 * 60_000)).toBe(AUTOPILOT_MAX_CLIPS);
  });
});
