import { describe, expect, it } from "vitest";

import {
  audioChain,
  cardArgs,
  concatArgs,
  concatList,
  fadeFramesFor,
  framesOf,
  lastUse,
  pieceArgs,
  pieceFrames,
  planPieces,
  samplesPerFrame,
  totalFrames,
  videoChain,
  type PartSource,
  type PieceOptions,
} from "./plan.js";

const OPTIONS: PieceOptions = { width: 1080, height: 1920, fps: 30, encoderThreads: 4 };

describe("frames and samples", () => {
  it("rounds a length to whole frames", () => {
    expect(framesOf(3_000, 30)).toBe(90);
    expect(framesOf(2_520, 30)).toBe(76);
    expect(framesOf(-5, 30)).toBe(0);
  });

  it("needs a rate that splits 48 kHz into whole samples a frame", () => {
    expect(samplesPerFrame(30)).toBe(1_600);
    expect(samplesPerFrame(25)).toBe(1_920);
    expect(() => samplesPerFrame(29)).toThrow(RangeError);
    expect(() => samplesPerFrame(0)).toThrow(RangeError);
  });
});

describe("fadeFramesFor", () => {
  it("is the fade asked for when every part is long enough", () => {
    expect(fadeFramesFor(15, [90, 76, 60])).toBe(15);
  });

  it("shortens so a middle part keeps a frame between its two fades", () => {
    expect(fadeFramesFor(15, [90, 20, 90])).toBe(9);
    expect(fadeFramesFor(15, [2, 90])).toBe(1);
    expect(fadeFramesFor(15, [1, 90])).toBe(0);
  });

  it("lets the first and last parts give up all but a frame", () => {
    // Two one-second parts keep the whole half-second fade: each keeps 15 frames.
    expect(fadeFramesFor(15, [30, 30])).toBe(15);
    expect(fadeFramesFor(15, [10, 90])).toBe(9);
  });

  it("is nothing with one part, or none asked for", () => {
    expect(fadeFramesFor(15, [90])).toBe(0);
    expect(fadeFramesFor(0, [90, 90])).toBe(0);
  });
});

describe("planPieces", () => {
  it("cuts each part's fades off its body and crossfades every join", () => {
    const pieces = planPieces([90, 76, 60], 15);
    expect(pieces).toEqual([
      { kind: "body", part: 0, from: 0, to: 75 },
      { kind: "fade", from: 0, into: 1, frames: 15 },
      { kind: "body", part: 1, from: 15, to: 61 },
      { kind: "fade", from: 1, into: 2, frames: 15 },
      { kind: "body", part: 2, from: 15, to: 60 },
    ]);
    const frames = pieces.reduce((sum, piece) => sum + pieceFrames(piece), 0);
    expect(frames).toBe(totalFrames([90, 76, 60], 15));
    expect(frames).toBe(90 + 76 + 60 - 2 * 15);
  });

  it("is one body for one part, and plain bodies with no fade", () => {
    expect(planPieces([90], 0)).toEqual([{ kind: "body", part: 0, from: 0, to: 90 }]);
    expect(planPieces([30, 30], 0)).toEqual([
      { kind: "body", part: 0, from: 0, to: 30 },
      { kind: "body", part: 1, from: 0, to: 30 },
    ]);
  });

  it("knows the last piece each part is read by", () => {
    const pieces = planPieces([90, 76, 60], 15);
    expect(lastUse(pieces, 3)).toEqual([1, 3, 4]);
  });
});

describe("pieceArgs", () => {
  const parts: PartSource[] = [
    { path: "/s/card.mov", frames: 60, hasAudio: true },
    { path: "/s/clip-0.mp4", frames: 900, hasAudio: true },
    { path: "/s/clip-1.mp4", frames: 600, hasAudio: false },
  ];

  it("reads a body from its first frame, normalised and held to its count", () => {
    const args = pieceArgs(
      { kind: "body", part: 1, from: 15, to: 885 },
      parts,
      "/s/p.mov",
      OPTIONS,
    );
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "0.500000"]);
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("scale=1080:1920:force_original_aspect_ratio=decrease");
    expect(graph).toContain("pad=1080:1920");
    expect(graph).toContain("fps=30:start_time=0");
    expect(graph).toContain("trim=end_frame=870");
    // 870 frames of sound at 1,600 samples a frame.
    expect(graph).toContain("atrim=end_sample=1392000");
    expect(args.at(-1)).toBe("/s/p.mov");
    expect(args).toContain("-nostdin");
  });

  it("gives a silent part silence of its own length", () => {
    const args = pieceArgs(
      { kind: "body", part: 2, from: 15, to: 600 },
      parts,
      "/s/p.mov",
      OPTIONS,
    );
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=end_sample=936000");
    expect(graph).not.toContain("[0:a]");
  });

  it("crossfades the end of one part into the start of the next, from two inputs", () => {
    const args = pieceArgs(
      { kind: "fade", from: 1, into: 2, frames: 15 },
      parts,
      "/s/f.mov",
      OPTIONS,
    );
    expect(args.filter((arg) => arg === "-i")).toHaveLength(2);
    // The fade out is read from 885 frames in: 29.5 s.
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual([
      "-ss",
      "29.500000",
      "-threads",
      "2",
    ]);
    const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
    expect(graph).toContain("xfade=transition=fade:duration=0.500000:offset=0");
    expect(graph).toContain("acrossfade=ns=24000");
    // The second part has no sound: it fades in from silence.
    expect(graph).toContain("anullsrc");
  });

  it("encodes every piece alike, with PCM sound, into MOV", () => {
    const body = pieceArgs({ kind: "body", part: 1, from: 0, to: 10 }, parts, "a.mov", OPTIONS);
    const fade = pieceArgs({ kind: "fade", from: 0, into: 1, frames: 5 }, parts, "b.mov", OPTIONS);
    const tail = (args: string[]): string[] => args.slice(args.indexOf("-c:v"), -1);
    expect(tail(body)).toEqual(tail(fade));
    expect(tail(body)).toEqual(
      expect.arrayContaining(["libx264", "pcm_s16le", "mov", "-threads", "4"]),
    );
  });

  it("refuses a piece that names a part it was not given", () => {
    expect(() =>
      pieceArgs({ kind: "body", part: 7, from: 0, to: 1 }, parts, "x.mov", OPTIONS),
    ).toThrow(RangeError);
  });
});

describe("the chains", () => {
  it("fits a part of another shape inside the canvas rather than cropping it", () => {
    const chain = videoChain("0:v", 10, { ...OPTIONS, width: 1080, height: 1080 });
    expect(chain).toContain("force_original_aspect_ratio=decrease");
    expect(chain).toContain("pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black");
  });

  it("fills a late start and pads short sound", () => {
    const chain = audioChain("1:a", 30, 30);
    expect(chain).toContain("aresample=48000:async=1:first_pts=0");
    expect(chain).toContain("apad=whole_len=48000,atrim=end_sample=48000");
  });
});

describe("the card and the join", () => {
  it("takes the card's frames on stdin, exactly its count, with silence beside them", () => {
    const args = cardArgs(60, "/s/card.mov", OPTIONS);
    expect(args).toContain("pipe:0");
    expect(args).not.toContain("-nostdin");
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual([
      "-frames:v",
      "60",
    ]);
    expect(args[args.indexOf("-s") + 1]).toBe("1080x1920");
  });

  it("lists the pieces by bare name with their exact lengths", () => {
    expect(
      concatList(
        [
          { file: "piece-000.mov", frames: 75 },
          { file: "piece-001.mov", frames: 15 },
        ],
        30,
      ),
    ).toBe(
      "ffconcat version 1.0\nfile piece-000.mov\nduration 2.500000\nfile piece-001.mov\nduration 0.500000\n",
    );
    expect(() => concatList([{ file: "../x.mov", frames: 1 }], 30)).toThrow(RangeError);
    expect(() => concatList([{ file: "a b.mov", frames: 1 }], 30)).toThrow(RangeError);
  });

  it("copies the picture and encodes the sound once", () => {
    const args = concatArgs("/s/pieces.ffconcat", "/s/out.mp4", OPTIONS);
    expect(args).toEqual(expect.arrayContaining(["-f", "concat", "-c:v", "copy", "-c:a", "aac"]));
    expect(args).toContain("+faststart");
    // Safe mode stays on: the list names bare files only.
    expect(args).not.toContain("-safe");
  });
});
