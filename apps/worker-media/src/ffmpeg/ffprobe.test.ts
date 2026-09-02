import { describe, expect, it } from "vitest";

import { MediaJobError } from "../errors.js";
import { pickDuration, readFrameRate, readProbe, readRotation, readVideo } from "./ffprobe.js";

import type { FfprobeOutput, FfprobeStream } from "./ffprobe.js";

const H264: FfprobeStream = {
  index: 0,
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  avg_frame_rate: "30000/1001",
  r_frame_rate: "30000/1001",
  pix_fmt: "yuv420p",
  color_transfer: "bt709",
  color_primaries: "bt709",
};

const AAC: FfprobeStream = {
  index: 1,
  codec_type: "audio",
  codec_name: "aac",
  channels: 2,
  sample_rate: "48000",
};

function output(streams: FfprobeStream[], format: FfprobeOutput["format"] = {}): FfprobeOutput {
  return { streams, format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", ...format } };
}

describe("readFrameRate", () => {
  it("evaluates the rational ffprobe reports", () => {
    expect(readFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(readFrameRate("25/1")).toBe(25);
    expect(readFrameRate("60/1")).toBe(60);
  });

  it("answers zero rather than NaN or Infinity for the degenerate cases", () => {
    // A still image reports `0/0`; a stream with no rate reports nothing at all.
    expect(readFrameRate("0/0")).toBe(0);
    expect(readFrameRate(undefined)).toBe(0);
    expect(readFrameRate("garbage")).toBe(0);
  });
});

describe("readRotation", () => {
  it("reads the display-matrix side data modern ffmpeg emits", () => {
    expect(readRotation({ side_data_list: [{ rotation: -90 }] })).toBe(270);
    expect(readRotation({ side_data_list: [{ rotation: 90 }] })).toBe(90);
    expect(readRotation({ side_data_list: [{ rotation: 180 }] })).toBe(180);
  });

  it("falls back to the `rotate` tag older builds set", () => {
    expect(readRotation({ tags: { rotate: "90" } })).toBe(90);
    expect(readRotation({ tags: { rotate: "270" } })).toBe(270);
  });

  it("treats anything that is not a quarter turn as no rotation", () => {
    expect(readRotation({})).toBe(0);
    expect(readRotation({ tags: { rotate: "17" } })).toBe(0);
    expect(readRotation({ side_data_list: [{ rotation: 0 }] })).toBe(0);
  });
});

describe("readVideo", () => {
  it("swaps the dimensions of a rotated portrait clip", () => {
    // The single most common real input: an iPhone held upright. Without the swap
    // every phone video gets a landscape proxy on its side.
    const video = readVideo({ ...H264, side_data_list: [{ rotation: -90 }] });
    expect(video.width).toBe(1080);
    expect(video.height).toBe(1920);
    expect(video.rotation).toBe(270);
  });

  it("leaves an unrotated stream alone", () => {
    const video = readVideo(H264);
    expect([video.width, video.height]).toEqual([1920, 1080]);
    expect(video.fps).toBeCloseTo(29.97, 2);
    expect(video.hdr).toBe(false);
  });

  it("flags PQ and HLG as HDR, and a wide gamut on an SDR curve as not", () => {
    expect(readVideo({ ...H264, color_transfer: "smpte2084" }).hdr).toBe(true);
    expect(readVideo({ ...H264, color_transfer: "arib-std-b67" }).hdr).toBe(true);
    // bt2020-10 is a wide gamut, not a transfer curve that needs tone mapping.
    expect(readVideo({ ...H264, color_transfer: "bt2020-10" }).hdr).toBe(false);
  });

  it("infers the bit depth from the pixel format when ffprobe does not say", () => {
    expect(readVideo({ ...H264, pix_fmt: "yuv420p10le" }).bitDepth).toBe(10);
    expect(readVideo({ ...H264, pix_fmt: "yuv420p" }).bitDepth).toBe(8);
    expect(readVideo({ ...H264, bits_per_raw_sample: "12" }).bitDepth).toBe(12);
  });
});

describe("pickDuration", () => {
  it("prefers the container's own duration", () => {
    expect(pickDuration(output([H264], { duration: "10.5" }), H264, AAC)).toBe(10_500);
  });

  it("falls back to a stream's when the container declares none", () => {
    // A recording killed mid-write has no container duration at all.
    const truncated = output([{ ...H264, duration: "7.25" }], { duration: "N/A" });
    expect(pickDuration(truncated, truncated.streams?.[0], undefined)).toBe(7_250);
  });

  it("answers zero rather than NaN when nothing declares one", () => {
    expect(pickDuration(output([H264], {}), H264, undefined)).toBe(0);
  });
});

describe("readProbe", () => {
  it("reads a normal video file", () => {
    const probe = readProbe(output([H264, AAC], { duration: "12.0", size: "4096" }));
    expect(probe.durationMs).toBe(12_000);
    expect(probe.sizeBytes).toBe(4_096);
    expect(probe.mime).toBe("video/mp4");
    expect(probe.video?.codec).toBe("h264");
    expect(probe.audio?.channels).toBe(2);
    expect(probe.audio?.sampleRate).toBe(48_000);
    // Loudness is a separate pass; the container read leaves it unset.
    expect(probe.audio?.loudnessLufs).toBeNull();
  });

  it("does not mistake an MP3's cover art for a video stream", () => {
    // Otherwise a podcast upload gets a proxy of its album art.
    const mp3 = readProbe({
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 600, height: 600 },
        { codec_type: "audio", codec_name: "mp3", channels: 2, sample_rate: "44100" },
      ],
      format: { format_name: "mp3", duration: "180" },
    });
    expect(mp3.video).toBeNull();
    expect(mp3.audio?.codec).toBe("mp3");
    expect(mp3.mime).toBe("audio/mpeg");
  });

  it("refuses a container with neither audio nor video", () => {
    // A PDF renamed `.mp4` gets this far and there is nothing downstream can do.
    const error = (() => {
      try {
        readProbe({ streams: [{ codec_type: "data" }], format: { format_name: "data" } });
        return null;
      } catch (caught) {
        return caught as MediaJobError;
      }
    })();
    expect(error).toBeInstanceOf(MediaJobError);
    expect(error?.reason).toBe("media/no_streams");
    // Terminal: retrying will not put a stream in the file.
    expect(error?.retryable).toBe(false);
  });
});
