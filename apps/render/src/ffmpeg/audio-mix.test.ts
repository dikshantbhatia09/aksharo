import { describe, expect, it } from "vitest";

import { buildTimeMap, cutEdit } from "@montaj/timemap";

import {
  buildAudioMixPlan,
  buildCueFilters,
  buildMusicFilters,
  speechRangesFromWords,
  type MusicMixCue,
  type SfxMixCue,
} from "./audio-mix.js";

const CUE: SfxMixCue = {
  itemId: "01JCUE0000000000000000000",
  startMs: 2_000,
  endMs: 3_000,
  gainDb: 0,
  fadeInMs: 50,
  fadeOutMs: 50,
  duck: null,
  localPath: "/tmp/cue.wav",
};

describe("speechRangesFromWords", () => {
  it("merges words closer than the merge gap into one region", () => {
    const ranges = speechRangesFromWords(
      [
        { s: 0, e: 400 },
        { s: 450, e: 900 }, // 50ms gap: merges
        { s: 2_000, e: 2_500 }, // far gap: new region
      ],
      3_000,
    );
    expect(ranges).toEqual([
      { startMs: 0, endMs: 900 },
      { startMs: 2_000, endMs: 2_500 },
    ]);
  });

  it("drops deleted words and clamps the last region to duration", () => {
    const ranges = speechRangesFromWords(
      [
        { s: 0, e: 500 },
        { s: 600, e: 900, deleted: true },
        { s: 950, e: 5_000 },
      ],
      4_000,
    );
    expect(ranges).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 950, endMs: 4_000 },
    ]);
  });

  it("returns an empty list for no words", () => {
    expect(speechRangesFromWords([], 1_000)).toEqual([]);
  });
});

describe("buildCueFilters — unedited timeline (identity map)", () => {
  it("builds one atrim/volume/adelay chain, no fades when neither is at an edge case", () => {
    const { filters, labels } = buildCueFilters(CUE, 2, null, []);
    expect(labels).toEqual(["sfx2_0"]);
    expect(filters).toHaveLength(1);
    const filter = filters[0] ?? "";
    expect(filter).toMatch(/^\[2:a]/);
    expect(filter).toContain("atrim=start=0.000000:end=1.000000");
    expect(filter).toContain("afade=type=in:start_time=0:duration=0.050000");
    expect(filter).toContain("afade=type=out:start_time=0.950000:duration=0.050000");
    expect(filter).toContain("adelay=2000|2000");
    expect(filter.endsWith("[sfx2_0]")).toBe(true);
  });

  it("applies a static volume filter for a non-zero gainDb", () => {
    const { filters } = buildCueFilters({ ...CUE, gainDb: -6 }, 0, null, []);
    expect(filters[0]).toContain("volume=0.501187");
  });

  it("omits the volume filter entirely at 0 dB", () => {
    const { filters } = buildCueFilters(CUE, 0, null, []);
    expect(filters[0]).not.toMatch(/volume=\d/);
  });

  it("adds the duck expression, after adelay, when the cue carries a duck curve", () => {
    const { filters } = buildCueFilters(
      { ...CUE, duck: { depthDb: -12, attackMs: 150, releaseMs: 150 } },
      0,
      null,
      [{ startMs: 0, endMs: 5_000 }],
    );
    const filter = filters[0] ?? "";
    const adelayIndex = filter.indexOf("adelay=");
    const duckIndex = filter.indexOf("volume=eval=frame");
    expect(adelayIndex).toBeGreaterThan(-1);
    expect(duckIndex).toBeGreaterThan(adelayIndex);
  });

  it("skips the duck expression when there are no speech ranges", () => {
    const { filters } = buildCueFilters(
      { ...CUE, duck: { depthDb: -12, attackMs: 150, releaseMs: 150 } },
      0,
      null,
      [],
    );
    expect(filters[0]).not.toContain("eval=frame");
  });
});

describe("buildCueFilters — cue split by a cut (mapRange remap)", () => {
  it("builds one chain per retained piece, fading only the piece touching the cue's real edge", () => {
    // Source: 0..10s. Cut removes [2.4s, 2.6s) — right in the middle of the
    // cue's own [2s, 3s) window, so mapRange splits it into two pieces.
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2_400, 2_600)] });
    const { filters, labels } = buildCueFilters(CUE, 5, map, []);
    expect(labels).toEqual(["sfx5_0", "sfx5_1"]);
    expect(filters).toHaveLength(2);

    // First piece: source [2000,2400) -> asset-local [0,400), touches the
    // cue's own start (assetStart 0) so it gets the fade-in; output starts at
    // the same instant (nothing ripples before the cut).
    expect(filters[0]).toContain("atrim=start=0.000000:end=0.400000");
    expect(filters[0]).toContain("afade=type=in");
    expect(filters[0]).not.toContain("afade=type=out");
    expect(filters[0]).toContain("adelay=2000|2000");

    // Second piece: source [2600,3000) -> asset-local [600,1000), touches the
    // cue's own end so it gets the fade-out; output start ripples left by the
    // 200ms the cut removed.
    expect(filters[1]).toContain("atrim=start=0.600000:end=1.000000");
    expect(filters[1]).toContain("afade=type=out");
    expect(filters[1]).not.toContain("afade=type=in");
    expect(filters[1]).toContain("adelay=2400|2400");
  });

  it("drops a cue entirely swallowed by a cut", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(1_500, 3_500)] });
    const { filters, labels } = buildCueFilters(CUE, 0, map, []);
    expect(filters).toEqual([]);
    expect(labels).toEqual([]);
  });
});

describe("buildMusicFilters", () => {
  const MUSIC: MusicMixCue = {
    itemId: "01JMUSIC000000000000000000",
    startMs: 0,
    endMs: 6_000,
    gainDb: -8,
    loopPolicy: "loop",
    bedDuck: null,
    localPath: "/tmp/music.wav",
    assetDurationMs: 2_000,
  };

  it("loops a bed shorter than its window with aloop, then trims to the window length", () => {
    const { filters, labels } = buildMusicFilters(MUSIC, 3, null, []);
    expect(labels).toEqual(["music3_0"]);
    expect(filters[0]).toContain("aloop=loop=-1");
    expect(filters[0]).toContain("atrim=start=0:end=6.000000");
    expect(filters[0]).toContain("volume=");
  });

  it("does not loop a bed already at least as long as its window", () => {
    const { filters } = buildMusicFilters({ ...MUSIC, assetDurationMs: 10_000 }, 0, null, []);
    expect(filters[0]).not.toContain("aloop");
    expect(filters[0]).toContain("atrim=start=0.000000:end=6.000000");
  });

  it("applies bedDuck as a per-frame duck expression when speech ranges exist", () => {
    const { filters } = buildMusicFilters(
      { ...MUSIC, bedDuck: { depthDb: -18, attackMs: 200, releaseMs: 200 } },
      0,
      null,
      [{ startMs: 1_000, endMs: 2_000 }],
    );
    expect(filters[0]).toContain("volume=eval=frame");
  });

  it("applies D05's fixed 300ms fade-in / 800ms fade-out at the bed's own window edges", () => {
    const { filters } = buildMusicFilters(MUSIC, 0, null, []);
    expect(filters[0]).toContain("afade=type=in:start_time=0:duration=0.300000");
    // Window is 6000ms; fade-out starts at 6000 - 800 = 5200ms.
    expect(filters[0]).toContain("afade=type=out:start_time=5.200000:duration=0.800000");
  });

  it("only fades the piece touching the bed's own real edge when split by a cut", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(3_000, 3_200)] });
    const { filters, labels } = buildMusicFilters(
      { ...MUSIC, assetDurationMs: 10_000, loopPolicy: "none" },
      0,
      map,
      [],
    );
    expect(labels).toEqual(["music0_0", "music0_1"]);
    expect(filters[0]).toContain("afade=type=in");
    expect(filters[0]).not.toContain("afade=type=out");
    expect(filters[1]).toContain("afade=type=out");
    expect(filters[1]).not.toContain("afade=type=in");
  });
});

describe("buildAudioMixPlan", () => {
  it("returns null when there is nothing to mix", () => {
    expect(
      buildAudioMixPlan({
        dialogueLabel: "0:a",
        sfxCues: [],
        musicCues: [],
        timemap: null,
        speechRanges: [],
        outputDurationMs: 5_000,
        nextInputIndex: 1,
        sampleRate: 48_000,
      }),
    ).toBeNull();
  });

  it("amixes the dialogue bus with one cue, assigning the next input index", () => {
    const plan = buildAudioMixPlan({
      dialogueLabel: "0:a",
      sfxCues: [CUE],
      musicCues: [],
      timemap: null,
      speechRanges: [],
      outputDurationMs: 5_000,
      nextInputIndex: 2,
      sampleRate: 48_000,
    });
    expect(plan).not.toBeNull();
    expect(plan?.extraInputArgs).toEqual(["-i", "/tmp/cue.wav"]);
    expect(plan?.filters.some((f) => f.startsWith("[2:a]"))).toBe(true);
    expect(plan?.filters.some((f) => f.includes("amix=inputs=2:normalize=0"))).toBe(true);
    expect(plan?.outLabel).toBe("mixout");
  });

  it("builds an anullsrc bed when there is no dialogue track but cues exist", () => {
    const plan = buildAudioMixPlan({
      dialogueLabel: null,
      sfxCues: [CUE],
      musicCues: [],
      timemap: null,
      speechRanges: [],
      outputDurationMs: 5_000,
      nextInputIndex: 1,
      sampleRate: 48_000,
    });
    expect(plan?.filters.some((f) => f.startsWith("anullsrc"))).toBe(true);
    expect(plan?.filters.some((f) => f.includes("amix=inputs=2:normalize=0"))).toBe(true);
  });

  it("passes the dialogue label through unchanged when every cue piece was cut away", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(1_500, 3_500)] });
    const plan = buildAudioMixPlan({
      dialogueLabel: "0:a",
      sfxCues: [CUE],
      musicCues: [],
      timemap: map,
      speechRanges: [],
      outputDurationMs: 8_000,
      nextInputIndex: 2,
      sampleRate: 48_000,
    });
    expect(plan?.outLabel).toBe("0:a");
    expect(plan?.filters.some((f) => f.includes("amix"))).toBe(false);
  });

  it("mixes both sfx and music cues alongside the dialogue bus", () => {
    const plan = buildAudioMixPlan({
      dialogueLabel: "cuta",
      sfxCues: [CUE],
      musicCues: [
        {
          itemId: "01JMUSIC000000000000000000",
          startMs: 0,
          endMs: 5_000,
          gainDb: -10,
          loopPolicy: "none",
          bedDuck: null,
          localPath: "/tmp/music.wav",
          assetDurationMs: 5_000,
        },
      ],
      timemap: null,
      speechRanges: [],
      outputDurationMs: 5_000,
      nextInputIndex: 3,
      sampleRate: 48_000,
    });
    expect(plan?.extraInputArgs).toEqual(["-i", "/tmp/cue.wav", "-i", "/tmp/music.wav"]);
    expect(plan?.filters.some((f) => f.startsWith("[3:a]"))).toBe(true);
    expect(plan?.filters.some((f) => f.startsWith("[4:a]"))).toBe(true);
    expect(plan?.filters.some((f) => f.includes("amix=inputs=3:normalize=0"))).toBe(true);
  });
});
