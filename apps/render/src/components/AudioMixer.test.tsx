import { describe, expect, it } from "vitest";

import {
  AudioMixer,
  DEFAULT_REMOTION_SFX_VOLUME,
  DEFAULT_SFX_GAIN_DB,
  MAX_SYNC_ACCURACY_MS,
  MIN_SFX_SPACING_MS,
  SfxEditorState,
  anchorCueToFrames,
  computeSfxDuckMultiplier,
  dbToLinearGain,
  frameToTimeSec,
  isVisualToAuditorySyncAccurate,
  timeSecToFrame,
  type RemotionSfxCue,
} from "./AudioMixer.js";

const SAMPLE_CUES: readonly RemotionSfxCue[] = [
  {
    id: "cue-1",
    assetId: "whoosh_fast",
    startMs: 1500, // frame 90 at 60 fps
    endMs: 2000,
    src: "/assets/sfx/whoosh_fast.wav",
    category: "whoosh",
    volume: 0.4,
  },
  {
    id: "cue-2",
    assetId: "pop_bubble",
    startMs: 4500, // frame 270 at 60 fps
    endMs: 4700,
    src: "/assets/sfx/pop_bubble.wav",
    category: "pop",
    volume: 0.4,
    duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
  },
];

describe("AudioMixer Remotion Sequencer & Contextual SFX (Pillar 5 §06)", () => {
  it("converts time and frames accurately at 60 fps", () => {
    expect(timeSecToFrame(1.5, 60)).toBe(90);
    expect(frameToTimeSec(90, 60)).toBe(1.5);
    expect(timeSecToFrame(0, 60)).toBe(0);
  });

  it("converts dB to linear amplitude gain", () => {
    const linear0 = dbToLinearGain(0);
    expect(linear0).toBeCloseTo(1.0, 3);

    const linearMinus18 = dbToLinearGain(DEFAULT_SFX_GAIN_DB);
    expect(linearMinus18).toBeGreaterThan(0.12);
    expect(linearMinus18).toBeLessThan(0.13); // ~0.12589
  });

  it("calculates exact frame coordinates and default calibrated volume", () => {
    const anchored = anchorCueToFrames(SAMPLE_CUES[0]!, 60, 600, 1.6);
    expect(anchored.fromFrame).toBe(90);
    expect(anchored.durationInFrames).toBe(30); // 500ms at 60 fps = 30 frames
    expect(anchored.effectiveVolume).toBe(DEFAULT_REMOTION_SFX_VOLUME);
    expect(anchored.isCurrent).toBe(true); // at 1.6s, cue-1 [1.5s, 2.0s] is playing
  });

  it("enforces visual-to-auditory sync accuracy SLA <= 16.6 ms", () => {
    expect(MAX_SYNC_ACCURACY_MS).toBe(16.6);
    // Exact match (0ms diff)
    expect(isVisualToAuditorySyncAccurate(1500, 1500)).toBe(true);
    // Within 1 frame at 60 fps (15ms diff)
    expect(isVisualToAuditorySyncAccurate(1500, 1515)).toBe(true);
    // Beyond 1 frame (>16.6ms) fails accuracy SLA
    expect(isVisualToAuditorySyncAccurate(1500, 1520)).toBe(false);
  });

  it("enforces pacing throttle SLA spacing of 2500ms", () => {
    expect(MIN_SFX_SPACING_MS).toBe(2500);
  });

  it("applies -12 dB duck under speech", () => {
    const speechRanges = [{ startMs: 4000, endMs: 5000 }];
    // At 4500ms (inside speech), gain should be ducked to ~0.25 (-12 dB)
    const ducked = computeSfxDuckMultiplier(4500, speechRanges);
    expect(ducked).toBeLessThan(0.3);

    // Outside speech + ramps (e.g. at 2000ms), gain should be 1.0
    const unducked = computeSfxDuckMultiplier(2000, speechRanges);
    expect(unducked).toBe(1.0);
  });

  it("manages interactive SFX operations in SfxEditorState", () => {
    const editor = new SfxEditorState(SAMPLE_CUES);
    expect(editor.getCues().length).toBe(2);

    // Mute cue-1
    editor.toggleMuteCue("cue-1", true);
    expect(editor.getCue("cue-1")?.isMuted).toBe(true);

    // Check effective volume when muted
    const mutedAnchored = anchorCueToFrames(editor.getCue("cue-1")!, 60);
    expect(mutedAnchored.effectiveVolume).toBe(0);

    // Swap cue-1 asset
    editor.swapCueAsset("cue-1", "whoosh_cinematic", "/assets/sfx/whoosh_cinematic.wav");
    expect(editor.getCue("cue-1")?.assetId).toBe("whoosh_cinematic");
    expect(editor.getCue("cue-1")?.src).toBe("/assets/sfx/whoosh_cinematic.wav");

    // Adjust volume
    editor.setCueVolume("cue-2", 0.6);
    expect(editor.getCue("cue-2")?.volume).toBe(0.6);

    // Remove cue
    editor.removeCue("cue-2");
    expect(editor.getCues().length).toBe(1);
    expect(editor.getCue("cue-2")).toBeUndefined();
  });

  it("renders Remotion AudioMixer VNode with sequence and audio elements", () => {
    const vnode = AudioMixer({
      sfxTracks: SAMPLE_CUES,
      currentTimeSec: 1.6,
      fps: 60,
    });

    expect(vnode.type).toBe("div");
    expect(vnode.props["data-fps"]).toBe("60");
    expect(vnode.props["data-active-cues"]).toBe("1");
    expect(vnode.props["data-total-cues"]).toBe("2");

    const children = vnode.props.children;
    expect(children.length).toBe(2);
  });
});
