import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AUDIOGRAM_FPS,
  CAPTION_BAND,
  PICTURE_BAND,
  audiogramArgs,
  audiogramFilter,
  audiogramLayout,
  audiogramSize,
  ffmpegColour,
  isHexColour,
  type AudiogramLayout,
} from "./audiogram.js";
import { CLIP_ASPECTS, type ClipAspect } from "./clip-frame.js";

function ffmpegAvailable(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0
  );
}

const CAN_RUN = ffmpegAvailable();
if (!CAN_RUN) console.warn("[audiogram.test] ffmpeg is not on PATH; the encode tests are skipped.");

const SHAPES: readonly { aspect: ClipAspect; maxHeight: number; width: number; height: number }[] =
  [
    { aspect: "9:16", maxHeight: 1_920, width: 1_080, height: 1_920 },
    { aspect: "4:5", maxHeight: 1_350, width: 1_080, height: 1_350 },
    { aspect: "1:1", maxHeight: 1_080, width: 1_080, height: 1_080 },
    { aspect: "16:9", maxHeight: 1_080, width: 1_920, height: 1_080 },
  ];

function inside(outer: { width: number; height: number }, box: AudiogramLayout["waveform"]) {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= outer.width &&
    box.y + box.height <= outer.height
  );
}

describe("audiogramSize", () => {
  it("is each shape's own canvas: what the API asks each shape to be cut at", () => {
    for (const shape of SHAPES) {
      expect(audiogramSize(shape.aspect, shape.maxHeight), shape.aspect).toEqual({
        width: shape.width,
        height: shape.height,
      });
    }
  });

  it("never goes past the tallest clip, and stays even", () => {
    expect(audiogramSize("9:16", 4_000)).toEqual({ width: 1_080, height: 1_920 });
    expect(audiogramSize("9:16", 721)).toEqual({ width: 406, height: 720 });
    expect(audiogramSize()).toEqual({ width: 1_080, height: 1_920 });
  });
});

describe("audiogramLayout", () => {
  for (const shape of SHAPES) {
    for (const artwork of [true, false]) {
      it(`keeps the caption band clear in ${shape.aspect}, ${artwork ? "with" : "without"} artwork`, () => {
        const size = { width: shape.width, height: shape.height };
        const layout = audiogramLayout(size, { artwork });
        const bandTop = Math.round(shape.height * CAPTION_BAND.top);
        const pictureTop = Math.round(shape.height * PICTURE_BAND.top);

        expect(inside(size, layout.waveform)).toBe(true);
        // Everything drawn sits between the picture band's top and the captions.
        expect(layout.waveform.y).toBeGreaterThanOrEqual(pictureTop);
        expect(layout.waveform.y + layout.waveform.height).toBeLessThanOrEqual(bandTop);
        // Centred, and never the full width.
        expect(layout.waveform.x * 2 + layout.waveform.width).toBeCloseTo(shape.width, -1);
        expect(layout.waveform.width).toBeLessThan(shape.width);
        // Even sizes: an odd one would be rounded by the encoder, off the layout.
        for (const value of [layout.waveform.width, layout.waveform.height]) {
          expect(value % 2).toBe(0);
        }

        if (!artwork) {
          expect(layout.artwork).toBeNull();
          return;
        }
        const art = layout.artwork;
        expect(art).not.toBeNull();
        if (art === null) return;
        expect(art.width).toBe(art.height);
        expect(inside(size, art)).toBe(true);
        expect(art.y).toBeGreaterThanOrEqual(pictureTop);
        // The artwork is above the waveform, and the two do not touch.
        expect(art.y + art.height).toBeLessThan(layout.waveform.y);
        expect(art.x * 2 + art.width).toBeCloseTo(shape.width, -1);
      });
    }
  }

  it("gives the waveform more room when there is no artwork", () => {
    const size = { width: 1_080, height: 1_920 };
    const alone = audiogramLayout(size, { artwork: false }).waveform;
    const under = audiogramLayout(size, { artwork: true }).waveform;
    expect(alone.height).toBeGreaterThan(under.height);
  });
});

describe("audiogramFilter", () => {
  const layout = audiogramLayout({ width: 1_080, height: 1_920 }, { artwork: true });
  const colours = { background: "#141217", accent: "#F0508A" };

  it("draws the ground, the artwork and the waveform, and splits the sound for both", () => {
    const graph = audiogramFilter(layout, colours, { artwork: true });
    expect(graph).toContain(`color=c=0x141217:s=1080x1920:r=${String(AUDIOGRAM_FPS)}[ground]`);
    expect(graph).toContain("[0:a]asplit=2[wavein][a]");
    expect(graph).toContain("colors=0xf0508a");
    expect(graph).toContain("[1:v]scale=");
    expect(graph).toContain("eof_action=repeat");
    expect(graph).toContain("shortest=1");
    expect(graph.endsWith("format=yuv420p[v]")).toBe(true);
  });

  it("reads no second input without artwork", () => {
    const bare = audiogramLayout({ width: 1_080, height: 1_920 }, { artwork: false });
    const graph = audiogramFilter(bare, colours, { artwork: false });
    expect(graph).not.toContain("[1:v]");
    expect(graph).toContain("[ground][wave]overlay");
  });

  it("refuses a colour that is not #RRGGBB rather than hand it to the parser", () => {
    expect(() => audiogramFilter(layout, { ...colours, accent: "red" }, { artwork: true })).toThrow(
      /#RRGGBB/,
    );
    expect(() =>
      audiogramFilter(layout, { ...colours, background: "#000000[x];" }, { artwork: false }),
    ).toThrow();
    expect(isHexColour("#abcdef")).toBe(true);
    expect(isHexColour("#abcde")).toBe(false);
    expect(ffmpegColour("#ABCDEF")).toBe("0xabcdef");
  });
});

describe("audiogramArgs", () => {
  it("bounds the read to the clip, reads the artwork once, and writes H.264 and AAC", () => {
    const layout = audiogramLayout({ width: 1_080, height: 1_920 }, { artwork: true });
    const args = audiogramArgs({
      sourceUrl: "https://store.test/raw.mp3?sig=1",
      artworkUrl: "https://store.test/cover.png?sig=2",
      startSec: "10.000",
      durationSec: "30.000",
      layout,
      request: { background: "#141217", accent: "#f1ece6" },
      outPath: "out.mp4",
    });
    const joined = args.join(" ");
    // The seek and the length come before the audio input, not the artwork's:
    // a seek on a one-frame image would leave it with no frame at all.
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("https://store.test/raw.mp3?sig=1"));
    expect(args.indexOf("https://store.test/raw.mp3?sig=1")).toBeLessThan(
      args.indexOf("https://store.test/cover.png?sig=2"),
    );
    expect(args.filter((arg) => arg === "-ss")).toHaveLength(1);
    expect(joined).toContain("-reconnect 1");
    expect(joined).toContain("-map [v] -map [a]");
    expect(joined).toContain("-c:v libx264");
    expect(joined).toContain("-c:a aac");
    expect(joined).toContain("+faststart");
    expect(args.at(-1)).toBe("out.mp4");
  });
});

describe.skipIf(!CAN_RUN)("an audiogram, encoded", () => {
  let dir = "";
  let audio = "";
  let art = "";

  function generate(args: readonly string[]): void {
    const result = spawnSync(
      "ffmpeg",
      ["-nostdin", "-hide_banner", "-loglevel", "error", ...args],
      {
        stdio: "pipe",
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    if (result.status !== 0) throw new Error(`fixture failed:\n${result.stderr}`);
  }

  function probe(file: string): {
    width: number;
    height: number;
    audio: boolean;
    durationMs: number;
  } {
    const result = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height:format=duration",
        "-of",
        "json",
        file,
      ],
      { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
    );
    const parsed = JSON.parse(result.stdout) as {
      streams: { codec_type: string; width?: number; height?: number }[];
      format: { duration: string };
    };
    const video = parsed.streams.find((stream) => stream.codec_type === "video");
    return {
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      audio: parsed.streams.some((stream) => stream.codec_type === "audio"),
      durationMs: Math.round(Number(parsed.format.duration) * 1000),
    };
  }

  /** One frame at `second`, as 8-bit luma, `width` wide. */
  function lumaAt(file: string, second: number): Buffer {
    const frame = spawnSync(
      "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        String(second),
        "-i",
        file,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ],
      { stdio: "pipe", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(frame.status).toBe(0);
    return frame.stdout as Buffer;
  }

  /** The lightest pixel in rows `[from, to)`. */
  function brightest(luma: Buffer, width: number, from: number, to: number): number {
    let max = 0;
    for (const value of luma.subarray(from * width, to * width)) max = Math.max(max, value);
    return max;
  }

  beforeAll(() => {
    return (async () => {
      dir = await mkdtemp(join(tmpdir(), "montaj-audiogram-test-"));
      audio = join(dir, "voice.m4a");
      // Loud enough that the waveform is drawn across its whole box.
      generate([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=48000:duration=4",
        "-af",
        "volume=0.9",
        "-c:a",
        "aac",
        audio,
      ]);
      art = join(dir, "cover.png");
      // A white square: its pixels are unmistakable on the dark ground.
      generate(["-y", "-f", "lavfi", "-i", "color=c=white:size=300x300", "-frames:v", "1", art]);
    })();
  });

  afterAll(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  function encode(
    aspect: ClipAspect,
    maxHeight: number,
    withArt: boolean,
  ): { out: string; layout: AudiogramLayout } {
    const layout = audiogramLayout(audiogramSize(aspect, maxHeight), { artwork: withArt });
    const out = join(dir, `ag-${aspect.replace(":", "x")}-${String(withArt)}.mp4`);
    const result = spawnSync(
      "ffmpeg",
      audiogramArgs({
        sourceUrl: audio,
        ...(withArt ? { artworkUrl: art } : {}),
        startSec: "0.500",
        durationSec: "2.000",
        layout,
        request: { background: "#141217", accent: "#f1ece6" },
        outPath: out,
      }),
      { stdio: "pipe", encoding: "utf8", timeout: 120_000 },
    );
    if (result.status !== 0) throw new Error(`audiogram encode failed:\n${result.stderr}`);
    return { out, layout };
  }

  for (const shape of SHAPES) {
    it(`makes a ${String(shape.width)} x ${String(shape.height)} video of the clip's length (${shape.aspect})`, () => {
      const { out } = encode(shape.aspect, shape.maxHeight, true);
      const facts = probe(out);
      expect(facts.width).toBe(shape.width);
      expect(facts.height).toBe(shape.height);
      expect(facts.audio).toBe(true);
      // Two seconds asked for; frame and AAC boundaries account for the rest.
      expect(Math.abs(facts.durationMs - 2_000)).toBeLessThan(150);
      expect(CLIP_ASPECTS[shape.aspect]).toBeDefined();
    }, 120_000);
  }

  it("draws the artwork and the waveform above the captions, and nothing where they go", () => {
    const { out, layout } = encode("9:16", 1_920, true);
    const luma = lumaAt(out, 1);
    const { width, height } = layout;
    const art = layout.artwork;
    expect(art).not.toBeNull();
    if (art === null) return;
    // The white artwork, in its square.
    expect(brightest(luma, width, art.y + 10, art.y + art.height - 10)).toBeGreaterThan(200);
    // The light waveform, in its box.
    expect(
      brightest(luma, width, layout.waveform.y, layout.waveform.y + layout.waveform.height),
    ).toBeGreaterThan(150);
    // The caption band is the ground alone: #141217 is luma ~20.
    expect(
      brightest(
        luma,
        width,
        Math.round(height * CAPTION_BAND.top),
        Math.round(height * CAPTION_BAND.bottom),
      ),
    ).toBeLessThan(40);
  }, 120_000);

  it("draws the waveform alone, larger, without artwork", () => {
    const { out, layout } = encode("16:9", 1_080, false);
    const facts = probe(out);
    expect(facts).toMatchObject({ width: 1_920, height: 1_080, audio: true });
    const luma = lumaAt(out, 1);
    expect(
      brightest(luma, 1_920, layout.waveform.y, layout.waveform.y + layout.waveform.height),
    ).toBeGreaterThan(150);
    expect(brightest(luma, 1_920, Math.round(1_080 * CAPTION_BAND.top), 1_080)).toBeLessThan(40);
  }, 120_000);
});
