import { describe, expect, it } from "vitest";

import type { FaceTrackDocument } from "@montaj/render-core";
import { MediaClipPayloadSchema } from "@montaj/repurpose-contracts";

import { SINGLE_LAYOUT, detectLayout } from "./layout.js";
import { CENTRE_REFRAME, framingFromTrack, layoutOfReframe } from "./reframe.js";

type Box = readonly [number, number, number, number];

/**
 * A face centred at `cx`, `cy`, `h` of the frame tall: about a head's shape on
 * a 16:9 frame (a face 0.14 tall is ~0.09 of the width).
 */
function face(cx: number, h = 0.14, cy = 0.4): Box {
  const w = (h * 9) / 16 / 0.9;
  return [cx - w / 2, cy - h / 2, w, h];
}

/** One sample every 250 ms from 0, each holding the boxes `at(i)` returns. */
function track(
  count: number,
  at: (index: number) => readonly Box[],
  source = { width: 1920, height: 1080 },
): FaceTrackDocument {
  return {
    version: 1,
    intervalMs: 250,
    source,
    samples: Array.from({ length: count }, (_, index) => [index * 250, at(index)]),
  };
}

/** Two people at a table, one wide camera: the owner's test runs. */
const PODCAST = track(80, () => [face(0.3, 0.14, 0.4), face(0.72, 0.13, 0.42)]);

describe("detectLayout (2026-10-01, two-speaker layouts)", () => {
  it("stacks two people seated side by side, the left one on top", () => {
    const decision = detectLayout(PODCAST, 0, 20_000, "auto");
    expect(decision.layout).toBe("stacked");
    expect(decision.people).toEqual([
      { centerX: 0.3, centerY: 0.4, size: 0.14 },
      { centerX: 0.72, centerY: 0.42, size: 0.13 },
    ]);
  });

  it("names the left seat first however the faces are listed or sized in each sample", () => {
    const decision = detectLayout(
      track(40, (i) =>
        i % 2 === 0 ? [face(0.72, 0.16), face(0.3, 0.12)] : [face(0.3, 0.12), face(0.72, 0.16)],
      ),
      0,
      10_000,
      "auto",
    );
    expect(decision.people?.map((person) => person.centerX)).toEqual([0.3, 0.72]);
  });

  it("keeps one person moving across the frame a single speaker, even when both are asked for", () => {
    // Never two faces at once: the seats would fill in turn, but never together.
    const walking = track(80, (i) => [face(0.2 + (0.6 * i) / 79)]);
    expect(detectLayout(walking, 0, 20_000, "auto")).toEqual(SINGLE_LAYOUT);
    expect(detectLayout(walking, 0, 20_000, "stacked")).toEqual(SINGLE_LAYOUT);
  });

  it("does not pick two of three people on its own, and does when both speakers are asked for", () => {
    const three = track(60, () => [face(0.18), face(0.5, 0.13), face(0.82, 0.135)]);
    expect(detectLayout(three, 0, 15_000, "auto")).toEqual(SINGLE_LAYOUT);
    const asked = detectLayout(three, 0, 15_000, "stacked");
    expect(asked.layout).toBe("stacked");
    // The two largest faces: the left one and the right one.
    expect(asked.people?.map((person) => person.centerX)).toEqual([0.18, 0.82]);
  });

  it("keeps one person briefly joined by another a single speaker", () => {
    // Someone leans in for the last fifth of the clip.
    const joined = track(80, (i) => (i < 64 ? [face(0.4)] : [face(0.4), face(0.8)]));
    expect(detectLayout(joined, 0, 20_000, "auto")).toEqual(SINGLE_LAYOUT);
    // Asked for, a fifth of the clip together is two people, not a false detection.
    expect(detectLayout(joined, 0, 20_000, "stacked").layout).toBe("stacked");
    // A glimpse is not.
    const glimpse = track(80, (i) => (i < 76 ? [face(0.4)] : [face(0.4), face(0.8)]));
    expect(detectLayout(glimpse, 0, 20_000, "stacked")).toEqual(SINGLE_LAYOUT);
  });

  it("stacks by seat, so two people who swap sides still fill both halves", () => {
    // They cross in the middle of the clip: the left seat is one of them before
    // and the other after, and it is the seat the window is on.
    const swapping = track(80, (i) => {
      const t = i / 79;
      const a = t < 0.45 ? 0.3 : t > 0.55 ? 0.7 : 0.3 + ((t - 0.45) / 0.1) * 0.4;
      return [face(a, 0.14), face(1 - a, 0.13)];
    });
    const decision = detectLayout(swapping, 0, 20_000, "auto");
    expect(decision.layout).toBe("stacked");
    expect(decision.people?.[0].centerX).toBeCloseTo(0.3, 2);
    expect(decision.people?.[1].centerX).toBeCloseTo(0.7, 2);
  });

  it("still stacks two people the detector misses now and then", () => {
    // Each loses their face a fifth of the time (a turned head), never together.
    const flicker = track(100, (i) => {
      if (i % 10 < 2) return [face(0.72, 0.13)];
      if (i % 10 >= 8) return [face(0.3)];
      return [face(0.3), face(0.72, 0.13)];
    });
    expect(detectLayout(flicker, 0, 25_000, "auto").layout).toBe("stacked");
  });

  it("leaves a vertical video one window, whoever is in it", () => {
    const vertical = track(40, () => [face(0.25, 0.1), face(0.75, 0.1)], {
      width: 1080,
      height: 1920,
    });
    expect(detectLayout(vertical, 0, 10_000, "auto")).toEqual(SINGLE_LAYOUT);
    expect(detectLayout(vertical, 0, 10_000, "stacked")).toEqual(SINGLE_LAYOUT);
  });

  it("leaves two people sitting close together one window, unless both are asked for", () => {
    const couch = track(40, () => [face(0.42, 0.14), face(0.6, 0.14)]);
    expect(detectLayout(couch, 0, 10_000, "auto")).toEqual(SINGLE_LAYOUT);
    expect(detectLayout(couch, 0, 10_000, "stacked").layout).toBe("stacked");
  });

  it("does not stack a speaker with a small face behind them, like one on a screen", () => {
    const screen = track(40, () => [face(0.35, 0.2), face(0.78, 0.07)]);
    expect(detectLayout(screen, 0, 10_000, "auto")).toEqual(SINGLE_LAYOUT);
  });

  it("does not stack two people who move about the frame", () => {
    // Each seat wanders across a third of the frame: no still window holds them.
    const restless = track(80, (i) => [
      face(0.1 + (i % 8) * 0.05),
      face(0.9 - ((i + 4) % 8) * 0.05),
    ]);
    expect(detectLayout(restless, 0, 20_000, "auto")).toEqual(SINGLE_LAYOUT);
  });

  it("is one window when asked for one speaker, or when the interval has nobody", () => {
    expect(detectLayout(PODCAST, 0, 20_000, "single")).toEqual(SINGLE_LAYOUT);
    expect(detectLayout(PODCAST, 60_000, 70_000, "auto")).toEqual(SINGLE_LAYOUT);
    expect(
      detectLayout(
        track(40, () => []),
        0,
        10_000,
        "stacked",
      ),
    ).toEqual(SINGLE_LAYOUT);
  });

  it("only reads the clip's own interval", () => {
    // A guest sits down half way through the source.
    const guest = track(160, (i) => (i < 80 ? [face(0.5)] : [face(0.3), face(0.72, 0.13)]));
    expect(detectLayout(guest, 0, 19_750, "auto")).toEqual(SINGLE_LAYOUT);
    expect(detectLayout(guest, 20_000, 39_750, "auto").layout).toBe("stacked");
  });

  it("skips boxes that are not numbers, and background-sized faces", () => {
    const messy = track(40, () => [
      face(0.3),
      [Number.NaN, 0.2, 0.1, 0.1],
      face(0.72, 0.13),
      face(0.5, 0.03),
    ]);
    expect(detectLayout(messy, 0, 10_000, "auto").layout).toBe("stacked");
  });
});

describe("framingFromTrack", () => {
  const interval = { fromMs: 0, toMs: 20_000 };

  it("adds the stack to the dominant speaker's window, as the contract takes it", () => {
    const framing = framingFromTrack(PODCAST, interval, "auto");
    expect(framing).toMatchObject({ centerX: 0.3, basis: "faces", layout: "stacked" });
    expect(framing.people).toHaveLength(2);
    expect(layoutOfReframe(framing)).toBe("stacked");
    const payload = MediaClipPayloadSchema.safeParse({
      schemaVersion: 1,
      runId: "01JCRN0000000000000000000A",
      candidateId: "01JCCANDA00000000000000000",
      clipId: "01JCC11PA00000000000000000",
      source: { bucket: "s3", key: "ws/a/raw.mp4" },
      sourceDurationMs: 60_000,
      startMs: 0,
      endMs: 20_000,
      handleMs: 500,
      destination: { bucket: "s3", key: "ws/a/master.mp4" },
      profile: { container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: 1920 },
      reframe: framing,
      profileVersion: "3",
    });
    expect(payload.success).toBe(true);
  });

  it("leaves a one-window framing exactly as it was before layouts", () => {
    const one = framingFromTrack(PODCAST, interval, "single");
    expect(one).toEqual({ centerX: 0.3, centerY: 0.4, basis: "faces" });
    expect(layoutOfReframe(one)).toBe("single");
    expect(framingFromTrack(undefined, interval, "stacked")).toEqual(CENTRE_REFRAME);
  });

  it("never stacks a square or wide cut", () => {
    for (const shape of ["1:1", "16:9"]) {
      expect(framingFromTrack(PODCAST, interval, "stacked", shape).layout).toBeUndefined();
    }
    expect(framingFromTrack(PODCAST, interval, "stacked", "4:5").layout).toBe("stacked");
  });
});
