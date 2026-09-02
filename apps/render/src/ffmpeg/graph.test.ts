import { describe, expect, it } from "vitest";

import { RenderManifestSchema, withSignature } from "@montaj/render-manifest";
import type { RenderManifest, UnsignedRenderManifest } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";
import { buildTimeMap, cutEdit, holdEdit, speedEdit } from "@montaj/timemap";

import {
  AUDIO_SAMPLE_RATE,
  buildFfmpegArgs,
  GraphError,
  isUnedited,
  isVideoEncoder,
  outputBearingSpans,
  overlayFrameCount,
  VIDEO_ENCODERS,
  type GraphInput,
} from "./graph.js";

const SECRET = "graph-test-secret";

function manifest(
  overrides: Parameters<typeof fixtureManifest>[0] = {},
  stripCrf = false,
): RenderManifest {
  const unsigned = fixtureManifest(overrides) as UnsignedRenderManifest;
  // The fixture picks a CRF; a test of the *default* has to take it away first,
  // because `fixtureManifest` merges nested objects rather than replacing them.
  const trimmed = stripCrf
    ? ({ ...unsigned, output: { ...unsigned.output, crf: undefined } } as UnsignedRenderManifest)
    : unsigned;
  return RenderManifestSchema.parse(withSignature(trimmed, SECRET));
}

function graph(
  overrides: Parameters<typeof fixtureManifest>[0] = {},
  extra: Partial<GraphInput> = {},
  stripCrf = false,
): ReturnType<typeof buildFfmpegArgs> {
  const built = manifest(overrides, stripCrf);
  const map = buildTimeMap({
    sourceDurationMs: built.timemap.sourceDurationMs,
    edits: built.timemap.edits,
  });
  return buildFfmpegArgs({
    manifest: built,
    sourcePath: "/tmp/source.mp4",
    sourceWidth: built.source.width ?? 1080,
    sourceHeight: built.source.height ?? 1920,
    sourceHasAudio: true,
    spans: map.spans,
    outputDurationMs: map.outputDurationMs,
    outputPath: "/tmp/out.mp4",
    encoder: "libx264",
    ...extra,
  });
}

describe("the encoder selection", () => {
  it("knows only the two encoders the service supports", () => {
    expect(VIDEO_ENCODERS).toEqual(["libx264", "h264_nvenc"]);
    expect(isVideoEncoder("libx264")).toBe(true);
    expect(isVideoEncoder("h264_nvenc")).toBe(true);
    expect(isVideoEncoder("hevc_videotoolbox")).toBe(false);
    expect(isVideoEncoder(undefined)).toBe(false);
  });
});

describe("frame counting", () => {
  it("rounds to the nearest whole frame and never asks for none", () => {
    expect(overlayFrameCount(10_000, 30)).toBe(300);
    expect(overlayFrameCount(7_000, 12)).toBe(84);
    expect(overlayFrameCount(33, 30)).toBe(1);
    expect(overlayFrameCount(0, 30)).toBe(1);
  });
});

describe("the span list", () => {
  it("drops the cuts, which are exactly the spans with no output width", () => {
    const map = buildTimeMap({
      sourceDurationMs: 10_000,
      edits: [cutEdit(2_000, 3_000)],
    });
    expect(map.spans).toHaveLength(3);
    expect(outputBearingSpans(map.spans)).toHaveLength(2);
    expect(isUnedited(map.spans)).toBe(false);
  });

  it("recognises an untouched timeline, so the graph can skip trim and concat", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [] });
    expect(isUnedited(map.spans)).toBe(true);
  });

  it("does not call a retimed timeline untouched", () => {
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [speedEdit(0, 10_000, 2)] });
    expect(isUnedited(map.spans)).toBe(false);
  });
});

describe("the default 1080p H.264 graph", () => {
  const plan = graph();

  it("takes the source first and the overlay pipe second", () => {
    const inputs = plan.args.filter((_arg, index) => plan.args[index - 1] === "-i");
    expect(inputs).toEqual(["/tmp/source.mp4", "pipe:0"]);
    expect(plan.args).toContain("rawvideo");
    expect(plan.args).toContain("rgba");
    expect(plan.args).toContain("1080x1920");
  });

  it("forces the base to the output frame rate before the overlay", () => {
    // Without this the concat's ragged span boundaries put the two streams a
    // frame apart and every caption drifts.
    expect(plan.filterGraph).toMatch(/fps=30\[base\]/);
    expect(plan.filterGraph.indexOf("fps=30")).toBeLessThan(plan.filterGraph.indexOf("overlay="));
  });

  it("overlays at the origin, in a format that keeps the alpha", () => {
    expect(plan.filterGraph).toContain("[base][1:v]overlay=x=0:y=0:eof_action=pass:format=auto");
  });

  it("skips trim and concat when nothing was edited", () => {
    expect(plan.filterGraph).not.toContain("trim=");
    expect(plan.filterGraph).not.toContain("concat=");
  });

  it("uses x264 veryfast at CRF 20 with faststart", () => {
    expect(plan.args).toContain("libx264");
    expect(plan.args.join(" ")).toContain("-preset veryfast");
    expect(plan.args.join(" ")).toContain("-crf 20");
    expect(plan.args.join(" ")).toContain("-movflags +faststart");
    expect(plan.args.join(" ")).toContain("-pix_fmt yuv420p");
  });

  it("re-encodes the audio to AAC at 48 kHz", () => {
    expect(plan.args.join(" ")).toContain("-c:a aac");
    expect(plan.args.join(" ")).toContain(`-ar ${String(AUDIO_SAMPLE_RATE)}`);
    expect(plan.hasAudio).toBe(true);
  });

  it("bounds the output with -t, so a late overlay frame cannot lengthen it", () => {
    expect(plan.args.join(" ")).toContain("-t 10.000");
    expect(plan.overlayFrames).toBe(300);
  });

  it("summarises itself for the log line", () => {
    expect(plan.summary).toContain("1080×1920@30");
    expect(plan.summary).toContain("300 overlay frames");
  });
});

describe("cuts", () => {
  const plan = graph({
    timemap: {
      sourceDurationMs: 10_000,
      snapCutsToFrames: false,
      edits: [cutEdit(2_000, 3_000), cutEdit(6_000, 6_500)],
    },
  });

  it("trims each retained span and concats them, video and audio together", () => {
    expect(plan.filterGraph).toContain("[0:v]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0]");
    expect(plan.filterGraph).toContain("[0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0]");
    expect(plan.filterGraph).toContain("concat=n=3:v=1:a=1[cutv][cuta]");
  });

  it("interleaves the concat labels the way the filter wants them", () => {
    expect(plan.filterGraph).toContain("[v0][a0][v1][a1][v2][a2]concat=");
  });

  it("shortens the output by exactly the cuts", () => {
    expect(plan.outputDurationMs).toBe(8_500);
    expect(plan.args.join(" ")).toContain("-t 8.500");
  });

  it("never copies the audio once it has been cut", () => {
    expect(plan.args).not.toContain("copy");
  });
});

describe("speed and freeze frames", () => {
  it("retimes a span with setpts and atempo", () => {
    const plan = graph({
      timemap: {
        sourceDurationMs: 10_000,
        snapCutsToFrames: false,
        edits: [speedEdit(2_000, 4_000, 2)],
      },
    });
    expect(plan.filterGraph).toContain("setpts=(PTS-STARTPTS)/2");
    expect(plan.filterGraph).toContain("atempo=2");
  });

  it("loops one frame for a freeze and fills the audio with silence", () => {
    const plan = graph({
      timemap: {
        sourceDurationMs: 10_000,
        snapCutsToFrames: false,
        edits: [holdEdit(4_000, 1_000)],
      },
    });
    expect(plan.filterGraph).toContain("loop=loop=29:size=1:start=0");
    expect(plan.filterGraph).toContain(`anullsrc=r=${String(AUDIO_SAMPLE_RATE)}:cl=stereo`);
    expect(plan.outputDurationMs).toBe(11_000);
  });
});

describe("presets", () => {
  it("scales and crops a landscape source into a Reel", () => {
    const plan = graph({}, { sourceWidth: 1920, sourceHeight: 1080 });
    expect(plan.filterGraph).toMatch(/scale=\d+:\d+:flags=bicubic/);
    expect(plan.filterGraph).toContain("crop=1080:1920:");
    expect(plan.filterGraph).toContain("setsar=1");
  });

  it("does nothing but set the sample aspect when the source already fits", () => {
    const plan = graph({}, { sourceWidth: 1080, sourceHeight: 1920 });
    expect(plan.filterGraph).not.toContain("scale=");
    expect(plan.filterGraph).not.toContain("crop=");
    expect(plan.filterGraph).toContain("setsar=1");
  });

  it("uses CRF 20 at 1080p and CRF 18 at 4K when the manifest names neither", () => {
    const fourK = {
      kind: "video",
      preset: "youtube-4k",
      aspect: "16:9",
      width: 3840,
      height: 2160,
      fps: 30,
      container: "mp4",
      videoCodec: "h264",
    } as const;
    expect(graph({ output: { ...fourK } }, {}, true).args.join(" ")).toContain("-crf 18");
    expect(graph({}, {}, true).args.join(" ")).toContain("-crf 20");
  });

  it("lets the manifest override the CRF", () => {
    expect(graph({ output: { crf: 27 } }).args.join(" ")).toContain("-crf 27");
  });
});

describe("the NVENC hook", () => {
  it("swaps the encoder without changing anything else about the graph", () => {
    const software = graph();
    const hardware = graph({}, { encoder: "h264_nvenc" });
    expect(hardware.args).toContain("h264_nvenc");
    expect(hardware.args).not.toContain("libx264");
    expect(hardware.args.join(" ")).toContain("-cq 20");
    expect(hardware.filterGraph).toBe(software.filterGraph);
  });
});

describe("alpha and green-screen exports", () => {
  const alphaOutput = {
    kind: "alpha",
    preset: "reels",
    aspect: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    container: "mov",
    videoCodec: "prores4444",
  } as const;

  it("emits the caption layer alone as ProRes 4444 with a real alpha plane", () => {
    const plan = graph({ output: { ...alphaOutput } }, { sourcePath: null });
    expect(plan.args.join(" ")).toContain("-c:v prores_ks -profile:v 4444");
    expect(plan.args.join(" ")).toContain("-pix_fmt yuva444p10le");
    expect(plan.filterGraph).toBe("");
    expect(plan.args).toContain("pipe:0");
  });

  it("emits VP9 with alpha for the WebM flavour", () => {
    const plan = graph(
      {
        output: {
          ...alphaOutput,
          container: "webm",
          videoCodec: "vp9",
        },
      },
      { sourcePath: null },
    );
    expect(plan.args.join(" ")).toContain("-c:v libvpx-vp9");
    expect(plan.args.join(" ")).toContain("-pix_fmt yuva420p");
    expect(plan.args.join(" ")).not.toContain("faststart");
  });

  it("refuses an alpha export in H.264, which has no alpha channel", () => {
    expect(() =>
      graph({ output: { ...alphaOutput, container: "mp4", videoCodec: "h264" } }),
    ).toThrow(GraphError);
  });

  it("builds a solid chroma ground for a green-screen export", () => {
    const plan = graph({
      output: {
        kind: "greenscreen",
        preset: "reels",
        aspect: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        container: "mp4",
        videoCodec: "h264",
        chromaKey: "#00b140",
      },
    });
    expect(plan.filterGraph).toContain("color=c=#00b140:s=1080x1920:r=30:d=10.000[ground]");
    expect(plan.filterGraph).toContain("[ground][0:v]overlay=");
  });
});

describe("audio strategies", () => {
  it("maps a third input when the manifest replaces the track", () => {
    const plan = graph(
      {
        audio: {
          strategy: "replace",
          cleanId: "01JA20SNDTRACK000000000000",
          cleanKey: "ws/x/clean.wav",
          codec: "aac",
          bitrateKbps: 192,
        },
      },
      { cleanAudioPath: "/tmp/clean.wav" },
    );
    expect(plan.args.filter((_a, index) => plan.args[index - 1] === "-i")).toEqual([
      "/tmp/source.mp4",
      "pipe:0",
      "/tmp/clean.wav",
    ]);
    expect(plan.args.join(" ")).toContain("-map 2:a");
  });

  it("refuses to replace a track it was given no file for", () => {
    expect(() =>
      graph({
        audio: {
          strategy: "replace",
          cleanKey: "ws/x/clean.wav",
          codec: "aac",
          bitrateKbps: 192,
        },
      }),
    ).toThrow(/no cleaned audio was supplied/);
  });

  it("writes no audio track when the manifest says none", () => {
    const plan = graph({
      audio: { strategy: "none", codec: "aac", bitrateKbps: 192 },
    });
    expect(plan.args).toContain("-an");
    expect(plan.hasAudio).toBe(false);
  });

  it("treats a silent source as silent rather than as an error", () => {
    const plan = graph({}, { sourceHasAudio: false });
    expect(plan.hasAudio).toBe(false);
    expect(plan.args).toContain("-an");
  });

  it("copies the samples only when nothing touched them", () => {
    const copyable = graph({
      audio: { strategy: "passthrough", codec: "copy", bitrateKbps: 192 },
    });
    expect(copyable.args.join(" ")).toContain("-c:a copy");

    const cut = graph({
      audio: { strategy: "passthrough", codec: "copy", bitrateKbps: 192 },
      timemap: {
        sourceDurationMs: 10_000,
        snapCutsToFrames: false,
        edits: [cutEdit(1_000, 2_000)],
      },
    });
    expect(cut.args.join(" ")).not.toContain("-c:a copy");
  });

  it("supports Opus and PCM for the containers that want them", () => {
    expect(
      graph({ audio: { strategy: "passthrough", codec: "opus", bitrateKbps: 128 } }).args.join(" "),
    ).toContain("-c:a libopus -b:a 128k");
    expect(
      graph({ audio: { strategy: "passthrough", codec: "pcm", bitrateKbps: 192 } }).args.join(" "),
    ).toContain("-c:a pcm_s16le");
  });
});

describe("refusals", () => {
  it("refuses a video render with no source to render over", () => {
    expect(() => graph({}, { sourcePath: null })).toThrow(GraphError);
  });
});
