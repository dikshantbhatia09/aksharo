import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  buildAudioMixPlan,
  buildCueFilters,
  buildDialogueDuckFilters,
  playedWindowOf,
  type SfxMixCue,
} from "./audio-mix.js";

/**
 * The voice-over hook (2026-10-01): a cue that plays straight through the cuts
 * after its start (`playThrough`) and pulls the clip's own sound down under it
 * (`dialogueDuck`). Every other cue is untouched - the existing suites in
 * `audio-mix.test.ts` still hold as they were.
 */
const VOICE: SfxMixCue = {
  itemId: "01JVOICE00000000000000000",
  startMs: 1_000,
  endMs: 4_000,
  gainDb: 0,
  fadeInMs: 20,
  fadeOutMs: 120,
  duck: null,
  localPath: "/tmp/hook.wav",
  playThrough: true,
  dialogueDuck: { depthDb: -14, attackMs: 200, releaseMs: 300 },
};

describe("playedWindowOf", () => {
  it("is the cue's own span on an unedited render", () => {
    expect(playedWindowOf(VOICE, null)).toEqual({
      outputStart: 1_000,
      outputEnd: 4_000,
      assetOffsetMs: 0,
    });
  });

  it("plays straight through a cut after its start, for its whole length", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2_000, 2_500)] });
    // A cut cue would end at 3,500 on the output clock; the voice keeps all 3 s.
    expect(playedWindowOf(VOICE, map)).toEqual({
      outputStart: 1_000,
      outputEnd: 4_000,
      assetOffsetMs: 0,
    });
  });

  it("starts where the video starts when a cut removed its own start", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(0, 1_500)] });
    expect(playedWindowOf(VOICE, map)).toEqual({
      outputStart: 0,
      outputEnd: 2_500,
      assetOffsetMs: 500,
    });
  });

  it("never runs past the end of the video", () => {
    expect(playedWindowOf(VOICE, null, 2_500)?.outputEnd).toBe(2_500);
    expect(playedWindowOf(VOICE, null, 900)).toBeNull();
  });
});

describe("buildCueFilters with playThrough", () => {
  it("is one chain, not one per retained piece", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2_000, 2_500)] });
    const built = buildCueFilters(VOICE, 3, map, [], 9_500);
    expect(built.labels).toEqual(["sfx3_0"]);
    expect(built.filters).toHaveLength(1);
    expect(built.filters[0]).toContain("atrim=start=0.000000:end=3.000000");
    expect(built.filters[0]).toContain("afade=type=in");
    expect(built.filters[0]).toContain("afade=type=out:start_time=2.880000:duration=0.120000");
    expect(built.filters[0]).toContain("adelay=1000|1000");
  });

  it("skips the fade-in when its start was cut away", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(0, 1_500)] });
    const [filter] = buildCueFilters(VOICE, 3, map, [], 8_500).filters;
    expect(filter).toContain("atrim=start=0.500000:end=3.000000");
    expect(filter).not.toContain("afade=type=in");
  });

  it("leaves an ordinary cue cut with the video", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2_000, 2_500)] });
    const ordinary: SfxMixCue = { ...VOICE, playThrough: false };
    expect(buildCueFilters(ordinary, 3, map, []).labels).toEqual(["sfx3_0", "sfx3_1"]);
  });
});

describe("buildDialogueDuckFilters", () => {
  it("ducks the bus over the window the voice plays in", () => {
    const built = buildDialogueDuckFilters({
      dialogueRef: "[aout]",
      sfxCues: [VOICE],
      timemap: null,
      outputDurationMs: 10_000,
    });
    expect(built?.outLabel).toBe("dialogueducked");
    expect(built?.filters[0]).toMatch(/^\[aout\]asetnsamples=n=64:p=0,volume=eval=frame/);
    // 1,000 ms - the 200 ms ramp, and 4,000 ms + the ramp.
    expect(built?.filters[0]).toContain("between(t,0.8,4.2)");
  });

  it("is null when no cue asks, so every other render keeps its bus", () => {
    expect(
      buildDialogueDuckFilters({
        dialogueRef: "[aout]",
        sfxCues: [{ ...VOICE, dialogueDuck: undefined } as SfxMixCue],
        timemap: null,
        outputDurationMs: 10_000,
      }),
    ).toBeNull();
  });
});

describe("buildAudioMixPlan with a voice-over", () => {
  it("mixes the voice over the ducked bus", () => {
    const plan = buildAudioMixPlan({
      dialogueLabel: "aout",
      sfxCues: [VOICE],
      musicCues: [],
      timemap: null,
      speechRanges: [],
      outputDurationMs: 10_000,
      nextInputIndex: 2,
      sampleRate: 48_000,
    });
    expect(plan?.extraInputArgs).toEqual(["-i", "/tmp/hook.wav"]);
    expect(plan?.filters.at(-1)).toBe("[dialogueducked][sfx2_0]amix=inputs=2:normalize=0[mixout]");
  });

  it("leaves the bus alone with no dialogue track", () => {
    const plan = buildAudioMixPlan({
      dialogueLabel: null,
      sfxCues: [VOICE],
      musicCues: [],
      timemap: null,
      speechRanges: [],
      outputDurationMs: 10_000,
      nextInputIndex: 1,
      sampleRate: 48_000,
    });
    expect(plan?.filters.some((filter) => filter.includes("dialogueducked"))).toBe(false);
  });
});
