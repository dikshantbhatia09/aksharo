import { describe, expect, it } from "vitest";
import {
  buildBumperConcatFiltergraph,
  computeBumperTimelineTiming,
  DEFAULT_COMPOSITION_FPS,
  DEFAULT_TARGET_LUFS,
  Series,
  SeriesSequence,
  VideoBumperComposition,
} from "./composition.js";
import { findVNodeByTestId, findVNodesByType } from "../components/SplitScreenView.js";

describe("Video Bumper Sequencer & Remotion Composition", () => {
  it("strictly enforces total duration equals intro + clip + outro", () => {
    const timing = computeBumperTimelineTiming({
      mainDurationSec: 30.0,
      introVideoSrc: "https://assets.aksharo.com/intro.mp4",
      introDurationSec: 2.0,
      outroVideoSrc: "https://assets.aksharo.com/outro.mp4",
      outroDurationSec: 2.5,
      fps: 30,
    });

    expect(timing.hasIntro).toBe(true);
    expect(timing.hasOutro).toBe(true);
    expect(timing.introDurationSec).toBe(2.0);
    expect(timing.mainDurationSec).toBe(30.0);
    expect(timing.outroDurationSec).toBe(2.5);
    // 2.0 + 30.0 + 2.5 = 34.5s
    expect(timing.totalDurationSec).toBe(34.5);

    // Frames: 2.0*30 = 60, 30.0*30 = 900, 2.5*30 = 75 => total = 1035 frames
    expect(timing.introFrames).toBe(60);
    expect(timing.mainFrames).toBe(900);
    expect(timing.outroFrames).toBe(75);
    expect(timing.totalFrames).toBe(1035);
    expect(timing.targetLufs).toBe(DEFAULT_TARGET_LUFS);
  });

  it("handles clips with intro bumper only", () => {
    const timing = computeBumperTimelineTiming({
      mainDurationSec: 15.0,
      introVideoSrc: "https://assets.aksharo.com/intro.mp4",
      introDurationSec: 2.0,
      fps: 30,
    });

    expect(timing.hasIntro).toBe(true);
    expect(timing.hasOutro).toBe(false);
    expect(timing.totalDurationSec).toBe(17.0);
    expect(timing.totalFrames).toBe(60 + 450); // 510 frames
  });

  it("handles clips with outro bumper only", () => {
    const timing = computeBumperTimelineTiming({
      mainDurationSec: 20.0,
      outroVideoSrc: "https://assets.aksharo.com/outro.mp4",
      outroDurationSec: 3.0,
      fps: 30,
    });

    expect(timing.hasIntro).toBe(false);
    expect(timing.hasOutro).toBe(true);
    expect(timing.totalDurationSec).toBe(23.0);
    expect(timing.totalFrames).toBe(600 + 90); // 690 frames
  });

  it("handles un-bumper-stitched standalone clips", () => {
    const timing = computeBumperTimelineTiming({
      mainDurationSec: 42.0,
      fps: 30,
    });

    expect(timing.hasIntro).toBe(false);
    expect(timing.hasOutro).toBe(false);
    expect(timing.totalDurationSec).toBe(42.0);
    expect(timing.totalFrames).toBe(42 * 30);
  });

  it("clamps bumper durations to safe bounds (intro 1.0s-3.0s, outro 1.5s-4.0s)", () => {
    const clamped = computeBumperTimelineTiming({
      mainDurationSec: 10.0,
      introVideoSrc: "intro.mp4",
      introDurationSec: 10.0, // exceeds max 3.0s
      outroVideoSrc: "outro.mp4",
      outroDurationSec: 0.2, // below min 1.5s
    });

    expect(clamped.introDurationSec).toBe(3.0);
    expect(clamped.outroDurationSec).toBe(1.5);
    expect(clamped.totalDurationSec).toBe(14.5);
  });

  it("renders Remotion <Series> with sequenced child sequences in exact order", () => {
    const vnode = VideoBumperComposition({
      mainVideoSrc: "main.mp4",
      mainDurationSec: 10.0,
      introVideoSrc: "intro.mp4",
      introDurationSec: 2.0,
      outroVideoSrc: "outro.mp4",
      outroDurationSec: 2.5,
      fps: DEFAULT_COMPOSITION_FPS,
      cornerLogo: {
        logoSrc: "logo.png",
        position: "TOP_LEFT",
      },
    });

    const root = findVNodeByTestId(vnode, "video-bumper-composition");
    expect(root).toBeDefined();
    expect(root?.props["data-total-duration-sec"]).toBe(14.5);

    const series = findVNodeByTestId(vnode, "bumper-series-root");
    expect(series).toBeDefined();

    const sequences = findVNodesByType(vnode, "SeriesSequence");
    expect(sequences.length).toBe(3);

    // Sequence 1: Intro (0 - 60 frames)
    expect(sequences[0]?.props["data-from-frame"]).toBe(0);
    expect(sequences[0]?.props["data-duration-frames"]).toBe(60);

    // Sequence 2: Main Clip (60 - 360 frames)
    expect(sequences[1]?.props["data-from-frame"]).toBe(60);
    expect(sequences[1]?.props["data-duration-frames"]).toBe(300);

    // Sequence 3: Outro (360 - 435 frames)
    expect(sequences[2]?.props["data-from-frame"]).toBe(360);
    expect(sequences[2]?.props["data-duration-frames"]).toBe(75);

    // Persistent Corner Logo is embedded in Main Clip container
    const cornerLogo = findVNodeByTestId(vnode, "main-clip-corner-logo");
    expect(cornerLogo).toBeDefined();
  });

  it("builds frame-accurate FFmpeg concatenation filtergraph with -14.0 LUFS audio normalization", () => {
    const ffmpegPlan = buildBumperConcatFiltergraph({
      mainVideoPath: "/tmp/main.mp4",
      mainDurationSec: 20.0,
      introVideoPath: "/tmp/intro.mp4",
      introDurationSec: 2.0,
      outroVideoPath: "/tmp/outro.mp4",
      outroDurationSec: 2.5,
      fps: 30,
      targetLufs: -14.0,
    });

    expect(ffmpegPlan.segmentCount).toBe(3);
    expect(ffmpegPlan.totalDurationSec).toBe(24.5);
    expect(ffmpegPlan.inputArgs).toEqual([
      "-i", "/tmp/intro.mp4",
      "-i", "/tmp/main.mp4",
      "-i", "/tmp/outro.mp4",
    ]);

    expect(ffmpegPlan.filtergraph).toContain("concat=n=3:v=1:a=1[v_concat][a_concat]");
    expect(ffmpegPlan.filtergraph).toContain("loudnorm=I=-14:LRA=7:TP=-1.5[a_out]");
    expect(ffmpegPlan.filtergraph).toContain("afade=t=in:ss=0:d=0.05");
  });
});
