import { describe, expect, it } from "vitest";

import { AUDIO_MIX_FIXTURE_CUES } from "./audio-mix-fixtures.js";
import { measureAudioMixParity, TOLERANCE_DB } from "./run-audio-mix-parity.js";

describe("D04e-3: audio mix envelope parity gate (real ffmpeg vs. the closed-form reference)", () => {
  it("stays within tolerance across the whole fixture, every cue window present on both sides", async () => {
    const measurement = await measureAudioMixParity("2026-01-01T00:00:00.000Z");

    expect(measurement.maxDeviationDb).toBeLessThanOrEqual(TOLERANCE_DB);
    expect(measurement.pass).toBe(true);
    expect(measurement.sampleCount).toBeGreaterThan(0);

    for (const cue of AUDIO_MIX_FIXTURE_CUES) {
      const presence = measurement.cueWindowsPresent[cue.itemId];
      expect(presence, `no cueWindowsPresent entry for ${cue.itemId}`).toBeDefined();
      expect(presence?.reference, `${cue.label}: reference window not present`).toBe(true);
      expect(presence?.cloud, `${cue.label}: cloud window not present`).toBe(true);
    }
  }, 120_000);
});
