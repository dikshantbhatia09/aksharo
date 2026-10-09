import { describe, expect, it } from "vitest";

import {
  buildDemuxArgs,
  planAudioTracks,
  DEMUX_SAMPLE_RATE,
} from "./demux-audio.js";

import type { ProbeAudioStream } from "../ffmpeg/ffprobe.js";

describe("planAudioTracks (Feature 08: Multi-Track Demuxing)", () => {
  it("plans multiple audio streams from OBS recording", () => {
    const streams: ProbeAudioStream[] = [
      {
        index: 0,
        codec: "aac",
        channels: 1,
        sampleRate: 48000,
        channelLayout: "mono",
        title: "Host Microphone",
      },
      {
        index: 1,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
        channelLayout: "stereo",
        title: "Discord Guest",
      },
      {
        index: 2,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
        channelLayout: "stereo",
        title: "Desktop Game Audio",
      },
    ];

    const plans = planAudioTracks(streams);
    expect(plans).toHaveLength(3);

    // Track 0: Host Mic
    expect(plans[0]?.streamIndex).toBe(0);
    expect(plans[0]?.label).toBe("Host Microphone");
    expect(plans[0]?.isDialogue).toBe(true);
    expect(plans[0]?.speakerName).toBe("Host");
    expect(plans[0]?.filename).toBe("track_0.wav");

    // Track 1: Guest Mic
    expect(plans[1]?.streamIndex).toBe(1);
    expect(plans[1]?.label).toBe("Discord Guest");
    expect(plans[1]?.isDialogue).toBe(true);
    expect(plans[1]?.speakerName).toBe("Guest");
    expect(plans[1]?.filename).toBe("track_1.wav");

    // Track 2: Game Audio (Story 2: Audio Track Muting / Non-dialogue exclusion)
    expect(plans[2]?.streamIndex).toBe(2);
    expect(plans[2]?.label).toBe("Desktop Game Audio");
    expect(plans[2]?.isDialogue).toBe(false);
    expect(plans[2]?.speakerName).toBe("");
    expect(plans[2]?.filename).toBe("track_2.wav");
  });

  it("plans stereo channel separation (e.g. Rodecaster Pro / Zoom 2-channel podcast)", () => {
    const streams: ProbeAudioStream[] = [
      {
        index: 0,
        codec: "pcm_s16le",
        channels: 2,
        sampleRate: 44100,
        channelLayout: "stereo",
        title: null,
      },
    ];

    const plans = planAudioTracks(streams);
    expect(plans).toHaveLength(2);

    expect(plans[0]?.streamIndex).toBe(0);
    expect(plans[0]?.channelIndex).toBe(0);
    expect(plans[0]?.label).toBe("Channel 1 (Left / Host)");
    expect(plans[0]?.speakerName).toBe("Host");
    expect(plans[0]?.isDialogue).toBe(true);
    expect(plans[0]?.useChannelPan).toBe(true);
    expect(plans[0]?.filename).toBe("track_0_ch0.wav");

    expect(plans[1]?.streamIndex).toBe(0);
    expect(plans[1]?.channelIndex).toBe(1);
    expect(plans[1]?.label).toBe("Channel 2 (Right / Guest)");
    expect(plans[1]?.speakerName).toBe("Guest");
    expect(plans[1]?.isDialogue).toBe(true);
    expect(plans[1]?.useChannelPan).toBe(true);
    expect(plans[1]?.filename).toBe("track_0_ch1.wav");
  });

  it("plans 4-channel polyphonic recording (e.g. Zoom PodTrak P4)", () => {
    const streams: ProbeAudioStream[] = [
      {
        index: 0,
        codec: "pcm_s24le",
        channels: 4,
        sampleRate: 48000,
        channelLayout: "4.0",
        title: null,
      },
    ];

    const plans = planAudioTracks(streams);
    expect(plans).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(plans[i]?.channelIndex).toBe(i);
      expect(plans[i]?.label).toBe(`Channel ${i + 1}`);
      expect(plans[i]?.speakerName).toBe(`Speaker ${i + 1}`);
      expect(plans[i]?.useChannelPan).toBe(true);
      expect(plans[i]?.filename).toBe(`track_0_ch${i}.wav`);
    }
  });

  it("returns single mono plan for standard mono file", () => {
    const streams: ProbeAudioStream[] = [
      {
        index: 0,
        codec: "aac",
        channels: 1,
        sampleRate: 16000,
        channelLayout: "mono",
        title: null,
      },
    ];

    const plans = planAudioTracks(streams);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.streamIndex).toBe(0);
    expect(plans[0]?.channelIndex).toBe(0);
    expect(plans[0]?.speakerName).toBe("Host");
    expect(plans[0]?.useChannelPan).toBe(false);
  });
});

describe("buildDemuxArgs (Single-Pass Multi-Track Extraction)", () => {
  it("generates fast single-pass stream mapping args for multi-stream containers", () => {
    const plans = [
      {
        streamIndex: 0,
        channelIndex: 0,
        label: "Host",
        filename: "track_0.wav",
        isDialogue: true,
        speakerName: "Host",
        useChannelPan: false,
      },
      {
        streamIndex: 1,
        channelIndex: 0,
        label: "Guest",
        filename: "track_1.wav",
        isDialogue: true,
        speakerName: "Guest",
        useChannelPan: false,
      },
    ];

    const args = buildDemuxArgs("input.mp4", plans, "/tmp/out");
    expect(args).toContain("-map");
    expect(args).toContain("0:a:0");
    expect(args).toContain("0:a:1");
    expect(args).toContain("-ar");
    expect(args).toContain(String(DEMUX_SAMPLE_RATE));
    expect(args).toContain("-c:a");
    expect(args).toContain("pcm_s16le");
  });

  it("generates filter_complex pan filters for channel separation", () => {
    const plans = [
      {
        streamIndex: 0,
        channelIndex: 0,
        label: "Left",
        filename: "track_0_ch0.wav",
        isDialogue: true,
        speakerName: "Host",
        useChannelPan: true,
      },
      {
        streamIndex: 0,
        channelIndex: 1,
        label: "Right",
        filename: "track_0_ch1.wav",
        isDialogue: true,
        speakerName: "Guest",
        useChannelPan: true,
      },
    ];

    const args = buildDemuxArgs("input.wav", plans, "/tmp/out");
    expect(args).toContain("-filter_complex");
    const filterArg = args[args.indexOf("-filter_complex") + 1];
    expect(filterArg).toContain("[0:a:0]pan=mono|c0=c0[out0]");
    expect(filterArg).toContain("[0:a:0]pan=mono|c0=c1[out1]");
    expect(args).toContain("-map");
    expect(args).toContain("[out0]");
    expect(args).toContain("[out1]");
  });
});

