import { describe, expect, it } from "vitest";

import { metricsSummary } from "./AudioPanel";
import { applyCleanOp, clearCleanOp } from "./use-audio-clean";

import type { AudioClean } from "./audio-endpoints";

function clean(overrides: Partial<AudioClean> = {}): AudioClean {
  return {
    id: "01JBQ8Z2W4N7Y0K3M5P8R1T6VE",
    projectId: "p1",
    mediaId: "m1",
    strength: "medium",
    target: "social",
    dereverb: false,
    deesser: false,
    status: "succeeded",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("metricsSummary", () => {
  it("formats the brief's example shape", () => {
    const row = clean({ metrics: { inputLufs: -12, outputLufs: -16, snrGainDb: 8 } });
    expect(metricsSummary(row)).toBe("-12 LUFS → -16 LUFS, noise reduced 8 dB");
  });

  it("omits the noise clause when there is no measurable gain", () => {
    const row = clean({ metrics: { inputLufs: -16, outputLufs: -16, snrGainDb: 0 } });
    expect(metricsSummary(row)).toBe("-16 LUFS → -16 LUFS");
  });

  it("is empty when metrics are missing", () => {
    expect(metricsSummary(clean({ metrics: undefined }))).toBe("");
  });
});

describe("SetAudio op builders", () => {
  it("applies the b10:<cleanId> preset convention exports.service.ts reads", () => {
    const row = clean({ id: "01JBQ8Z2W4N7Y0K3M5P8R1T6VE", target: "youtube" });
    const op = applyCleanOp(row);
    expect(op).toEqual({
      clean: { enabled: true, preset: "b10:01JBQ8Z2W4N7Y0K3M5P8R1T6VE", targetLufs: -14 },
    });
  });

  it("clears with enabled: false", () => {
    expect(clearCleanOp().clean.enabled).toBe(false);
  });
});
