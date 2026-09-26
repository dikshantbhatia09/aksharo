import { describe, expect, it, vi } from "vitest";

import type { FaceTrackDocument } from "@montaj/render-core";

import { CENTRE_REFRAME, reframeForClip, reframeFromFaces, reframeFromTrack } from "./reframe.js";

type Box = readonly [number, number, number, number];

/** A face whose horizontal centre is `cx`, `size` wide and tall (normalised). */
function face(cx: number, size = 0.2): Box {
  return [cx - size / 2, 0.2, size, size];
}

/** One sample every 250 ms from `startMs`, each holding the boxes `at(i)` returns. */
function track(
  count: number,
  at: (index: number) => readonly Box[],
  startMs = 0,
): FaceTrackDocument {
  return {
    version: 1,
    intervalMs: 250,
    source: { width: 1920, height: 1080 },
    samples: Array.from({ length: count }, (_, index) => [startMs + index * 250, at(index)]),
  };
}

describe("reframeFromFaces", () => {
  it("frames an off-centre single speaker on their face, not the frame centre", () => {
    // The interview framing that cut speakers out: someone on the right third.
    const reframe = reframeFromFaces(
      track(40, (i) => [face(0.72 + (i % 2 === 0 ? 0.01 : -0.01))]),
      0,
      10_000,
    );
    expect(reframe.basis).toBe("faces");
    expect(reframe.centerX).toBeCloseTo(0.72, 2);
  });

  it("picks the larger of two speakers who are both there throughout", () => {
    const reframe = reframeFromFaces(
      track(40, () => [face(0.3, 0.25), face(0.75, 0.12)]),
      0,
      10_000,
    );
    expect(reframe).toEqual({ centerX: 0.3, basis: "faces" });
  });

  it("prefers the face that is there most of the time over a bigger one glimpsed briefly", () => {
    // A face nearly three times the area, on screen for a quarter of the clip,
    // must not steal the frame from the person talking for all of it.
    const reframe = reframeFromFaces(
      track(40, (i) => (i < 10 ? [face(0.25, 0.25), face(0.7, 0.15)] : [face(0.7, 0.15)])),
      0,
      10_000,
    );
    expect(reframe.centerX).toBeCloseTo(0.7, 3);
  });

  it("keeps two people side by side as two tracks, however they alternate in size", () => {
    // Each sample is linked largest-first, so the two can never fold into one
    // track whose median lands between them — on nobody.
    const reframe = reframeFromFaces(
      track(40, (i) =>
        i % 2 === 0 ? [face(0.35, 0.2), face(0.62, 0.18)] : [face(0.62, 0.18), face(0.35, 0.2)],
      ),
      0,
      10_000,
    );
    expect(reframe.centerX).toBeCloseTo(0.35, 3);
  });

  it("still follows a speaker who is missing from some samples", () => {
    // Head turned away, a blink of the detector: 60 % presence is still the subject.
    const reframe = reframeFromFaces(
      track(50, (i) => (i % 5 < 3 ? [face(0.28)] : [])),
      0,
      12_500,
    );
    expect(reframe).toEqual({ centerX: 0.28, basis: "faces" });
  });

  it("uses the median, so a few stray detections do not drag the window", () => {
    const reframe = reframeFromFaces(
      track(21, (i) => [face(i < 3 ? 0.4 : 0.66)]),
      0,
      5_000,
    );
    expect(reframe.centerX).toBeCloseTo(0.66, 3);
  });

  it("only looks at the clip's own interval", () => {
    // Before the clip the speaker was on the left; during it, on the right.
    const doc = track(80, (i) => [face(i < 40 ? 0.2 : 0.8)]);
    expect(reframeFromFaces(doc, 10_000, 19_750).centerX).toBeCloseTo(0.8, 3);
    expect(reframeFromFaces(doc, 0, 9_750).centerX).toBeCloseTo(0.2, 3);
  });

  it("falls back to the centre when no one is in the picture", () => {
    expect(
      reframeFromFaces(
        track(40, () => []),
        0,
        10_000,
      ),
    ).toEqual(CENTRE_REFRAME);
  });

  it("falls back to the centre when the interval has no samples at all", () => {
    expect(
      reframeFromFaces(
        track(40, () => [face(0.2)]),
        60_000,
        70_000,
      ),
    ).toEqual(CENTRE_REFRAME);
  });

  it("ignores background-sized faces", () => {
    expect(
      reframeFromFaces(
        track(40, () => [face(0.2, 0.04)]),
        0,
        10_000,
      ),
    ).toEqual(CENTRE_REFRAME);
  });

  it("does not frame on a face seen too rarely to be the speaker", () => {
    // Three samples in forty: a poster on the wall, or a false detection.
    expect(
      reframeFromFaces(
        track(40, (i) => (i < 3 ? [face(0.15)] : [])),
        0,
        10_000,
      ),
    ).toEqual(CENTRE_REFRAME);
  });

  it("skips boxes and samples that are not numbers, instead of framing on NaN", () => {
    // `parseFaceTrack` checks the envelope only. A string coordinate used to
    // make the centre NaN, which failed the payload contract and the whole cut.
    const doc = {
      ...track(40, () => [face(0.7)]),
      samples: [
        ...track(40, () => [face(0.7)]).samples,
        [10_000, [["0.1", 0.2, 0.2, 0.2]]],
        [10_000, [[0.1, 0.2, Number.NaN, 0.2]]],
        [10_000, [null]],
        ["10000", [face(0.1)]],
        [10_000, "nobody"],
        null,
      ],
    } as unknown as FaceTrackDocument;
    const reframe = reframeFromFaces(doc, 0, 10_000);
    expect(reframe.basis).toBe("faces");
    expect(reframe.centerX).toBeCloseTo(0.7, 3);
  });

  it("keeps the answer inside the frame", () => {
    const reframe = reframeFromFaces(
      track(10, () => [[0.9, 0.2, 0.3, 0.3]]),
      0,
      2_500,
    );
    expect(reframe.centerX).toBeLessThanOrEqual(1);
    expect(reframe.centerX).toBeGreaterThanOrEqual(0);
  });
});

describe("reframeFromTrack", () => {
  it("is the centre with no track, and the faces' answer with one", () => {
    expect(reframeFromTrack(undefined, { fromMs: 0, toMs: 10_000 })).toEqual(CENTRE_REFRAME);
    expect(
      reframeFromTrack(
        track(40, () => [face(0.3)]),
        { fromMs: 0, toMs: 10_000 },
      ),
    ).toEqual({ centerX: 0.3, basis: "faces" });
  });

  it("is the centre, not an exception, for a track it cannot even walk", () => {
    const broken = { ...track(1, () => []), samples: 42 } as unknown as FaceTrackDocument;
    expect(reframeFromTrack(broken, { fromMs: 0, toMs: 10_000 })).toEqual(CENTRE_REFRAME);
  });
});

describe("reframeForClip", () => {
  const interval = { fromMs: 0, toMs: 10_000 };

  function deps(body?: Buffer | Error) {
    return {
      derived: {
        get: vi.fn(async () => {
          if (body instanceof Error) throw body;
          return body ?? Buffer.from("{}");
        }),
      } as never,
      faces: { maybeEnqueue: vi.fn(async () => undefined) },
      warn: vi.fn(),
    };
  }

  it("reads the source's faces.json and frames on it", async () => {
    const d = deps(Buffer.from(JSON.stringify(track(40, () => [face(0.7)]))));
    const reframe = await reframeForClip(
      d,
      { id: "M1", facesKey: "ws/w/p/p/media/M1/faces.json" },
      interval,
    );
    expect(reframe).toEqual({ centerX: 0.7, basis: "faces" });
    expect(d.faces.maybeEnqueue).not.toHaveBeenCalled();
  });

  it("queues detection for a source that has none yet, once, and cuts on the centre", async () => {
    const d = deps();
    const reframe = await reframeForClip(d, { id: "M1", facesKey: null }, interval);
    expect(reframe).toEqual(CENTRE_REFRAME);
    expect(d.faces.maybeEnqueue).toHaveBeenCalledWith("M1", { onlyIfNeverTried: true });
  });

  it("cuts on the centre when the track cannot be read", async () => {
    const d = deps(new Error("NoSuchKey"));
    expect(await reframeForClip(d, { id: "M1", facesKey: "k/faces.json" }, interval)).toEqual(
      CENTRE_REFRAME,
    );
    expect(d.warn).toHaveBeenCalled();
  });

  it("cuts on the centre, and never throws, when detection cannot be queued", async () => {
    const d = deps();
    d.faces.maybeEnqueue.mockRejectedValue(new Error("redis down"));
    expect(await reframeForClip(d, { id: "M1", facesKey: null }, interval)).toEqual(CENTRE_REFRAME);
  });

  it("cuts on the centre when the track holds nothing but garbage", async () => {
    const garbage = { ...track(4, () => []), samples: [[0, [["x", "y", "w", "h"]]]] };
    expect(
      await reframeForClip(
        deps(Buffer.from(JSON.stringify(garbage))),
        { id: "M1", facesKey: "k" },
        interval,
      ),
    ).toEqual(CENTRE_REFRAME);
  });

  it("cuts on the centre when the track is not JSON or not a version it reads", async () => {
    expect(
      await reframeForClip(deps(Buffer.from("not json")), { id: "M1", facesKey: "k" }, interval),
    ).toEqual(CENTRE_REFRAME);
    expect(
      await reframeForClip(
        deps(Buffer.from(JSON.stringify({ ...track(4, () => [face(0.7)]), version: 99 }))),
        { id: "M1", facesKey: "k" },
        interval,
      ),
    ).toEqual(CENTRE_REFRAME);
  });
});
