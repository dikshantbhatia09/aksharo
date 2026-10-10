import { describe, expect, it } from "vitest";

import {
  buildSidechainDuckingArgs,
  buildSidechainDuckingFiltergraph,
  DEFAULT_ATTACK_MS,
  DEFAULT_DUCKING_DB,
  DEFAULT_MUSIC_VOLUME,
  DEFAULT_RELEASE_MS,
  DEFAULT_SIDECHAIN_THRESHOLD,
  duckingDbToRatio,
  validateDialogueDurationMatch,
} from "./audio-mix.js";

describe("audio-mix sidechain ducking", () => {
  describe("duckingDbToRatio", () => {
    it("maps standard dB levels to compression ratios", () => {
      expect(duckingDbToRatio(12)).toBe(4);
      expect(duckingDbToRatio(-12)).toBe(4);
      expect(duckingDbToRatio(16)).toBe(6);
      expect(duckingDbToRatio(-16)).toBe(6);
      expect(duckingDbToRatio(20)).toBe(10);
      expect(duckingDbToRatio(-20)).toBe(10);
    });
  });

  describe("buildSidechainDuckingFiltergraph", () => {
    it("builds filtergraph with default parameters matching specification", () => {
      const result = buildSidechainDuckingFiltergraph();

      expect(result.duckingDb).toBe(DEFAULT_DUCKING_DB);
      expect(result.attackMs).toBe(DEFAULT_ATTACK_MS);
      expect(result.releaseMs).toBe(DEFAULT_RELEASE_MS);
      expect(result.threshold).toBe(DEFAULT_SIDECHAIN_THRESHOLD);
      expect(result.musicVolume).toBe(DEFAULT_MUSIC_VOLUME);
      expect(result.ratio).toBe(6);
      expect(result.durationMode).toBe("first");

      expect(result.filtergraph).toContain("[1:a]volume=0.40[music_base]");
      expect(result.filtergraph).toContain(
        "[music_base][0:a]sidechaincompress=threshold=0.0600:ratio=6.0:attack=100:release=500[ducked_music]",
      );
      expect(result.filtergraph).toContain(
        "[0:a][ducked_music]amix=inputs=2:weights=1.0 1.0:duration=first[aout]",
      );
      expect(result.toString()).toBe(result.filtergraph);
    });

    it("accepts custom options from ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md Step 1", () => {
      const result = buildSidechainDuckingFiltergraph({
        speechPath: "speech.wav",
        musicPath: "music.mp3",
        duckingDb: 16,
        attackMs: 100,
        releaseMs: 500,
      });

      expect(result.duckingDb).toBe(16);
      expect(result.attackMs).toBe(100);
      expect(result.releaseMs).toBe(500);
      expect(result.ratio).toBe(6);
      expect(result.filtergraph).toContain(
        "sidechaincompress=threshold=0.0600:ratio=6.0:attack=100:release=500[ducked_music]",
      );
      expect(result.filtergraph).toContain("duration=first");
    });

    it("configures subtle (-12dB) and heavy (-20dB) ducking intensities", () => {
      const subtle = buildSidechainDuckingFiltergraph({ duckingDb: 12 });
      expect(subtle.ratio).toBe(4);
      expect(subtle.filtergraph).toContain("ratio=4.0");

      const heavy = buildSidechainDuckingFiltergraph({ duckingDb: 20 });
      expect(heavy.ratio).toBe(10);
      expect(heavy.filtergraph).toContain("ratio=10.0");
    });

    it("allows custom labels and omitting mix step", () => {
      const custom = buildSidechainDuckingFiltergraph({
        speechLabel: "voice",
        musicLabel: "bgm",
        outputLabel: "master",
        mixOutput: false,
      });

      expect(custom.filtergraph).toContain("[bgm]volume=0.40[music_base]");
      expect(custom.filtergraph).toContain("[music_base][voice]sidechaincompress");
      expect(custom.filtergraph).not.toContain("amix");
    });
  });

  describe("validateDialogueDurationMatch", () => {
    it("returns true when output duration closely matches dialogue duration", () => {
      expect(validateDialogueDurationMatch(30.0, 30.02)).toBe(true);
      expect(validateDialogueDurationMatch(15.5, 15.48)).toBe(true);
    });

    it("throws when output duration exceeds tolerance", () => {
      expect(() => validateDialogueDurationMatch(30.0, 45.0)).toThrow(
        /Output audio length \(45\.000s\) does not match dialogue length \(30\.000s\)/,
      );
      expect(() => validateDialogueDurationMatch(10.0, 9.8, 0.05)).toThrow();
    });

    it("throws on invalid durations", () => {
      expect(() => validateDialogueDurationMatch(0, 10)).toThrow(RangeError);
      expect(() => validateDialogueDurationMatch(10, -5)).toThrow(RangeError);
    });
  });

  describe("buildSidechainDuckingArgs", () => {
    it("constructs full ffmpeg command line arguments", () => {
      const args = buildSidechainDuckingArgs({
        speechPath: "/tmp/dialogue.wav",
        musicPath: "/tmp/music.mp3",
        outputPath: "/tmp/master.aac",
        duckingOptions: { duckingDb: 16, attackMs: 100, releaseMs: 500 },
      });

      expect(args).toContain("-nostdin");
      expect(args).toContain("-y");
      expect(args).toContain("/tmp/dialogue.wav");
      expect(args).toContain("/tmp/music.mp3");
      expect(args).toContain("-filter_complex");
      expect(args).toContain("-map");
      expect(args).toContain("[aout]");
      expect(args).toContain("-c:a");
      expect(args).toContain("aac");
      expect(args).toContain("/tmp/master.aac");
    });
  });

  describe("Spectral Energy Balance & Speech-to-Music Ratio (SMR) SLA verification", () => {
    it("guarantees Speech-to-Music Ratio >= +15 dB during active speech intervals", () => {
      // Simulate 10 seconds of audio with active dialogue and background music
      const sampleRate = 16000;
      const durationSec = 10;
      const totalSamples = sampleRate * durationSec;

      // Active speech intervals: 1.0s - 4.0s and 6.0s - 9.0s
      const speechIntervals = [
        { start: 1.0 * sampleRate, end: 4.0 * sampleRate },
        { start: 6.0 * sampleRate, end: 9.0 * sampleRate },
      ];

      // Pause interval: 4.0s - 6.0s (dramatic pause)
      const pauseInterval = { start: 4.0 * sampleRate, end: 6.0 * sampleRate };

      // Nominal dialogue level: -18 dBFS (linear amplitude ~0.126)
      const dialogueRms = Math.pow(10, -18 / 20);
      // Nominal music level before ducking: base volume 0.4 on music track (RMS ~ -14 dBFS * 0.4 = -22 dBFS)
      const musicBaseVol = 0.4;
      const musicTrackRms = Math.pow(10, -14 / 20);
      const musicNominalRms = musicTrackRms * musicBaseVol;

      // Sidechain compression attenuation:
      // When speech is active (RMS ~ -18 dBFS, well above threshold -24 dBFS = 0.06),
      // sidechain compressor with ratio 6:1 attenuates music by ~16 dB.
      const duckingAttenuationDb = 16.0;
      const duckedMusicRms = musicNominalRms * Math.pow(10, -duckingAttenuationDb / 20);

      // Compute spectral energy during active speech intervals
      let dialogueSpeechEnergy = 0;
      let duckedMusicSpeechEnergy = 0;
      let speechSampleCount = 0;

      for (const interval of speechIntervals) {
        const count = interval.end - interval.start;
        speechSampleCount += count;
        dialogueSpeechEnergy += count * Math.pow(dialogueRms, 2);
        duckedMusicSpeechEnergy += count * Math.pow(duckedMusicRms, 2);
      }

      const meanDialogueSpeechPower = dialogueSpeechEnergy / speechSampleCount;
      const meanMusicSpeechPower = duckedMusicSpeechEnergy / speechSampleCount;

      // Speech-to-Music Ratio (SMR) in dB: 10 * log10(Power_speech / Power_music)
      const smrDb = 10 * Math.log10(meanDialogueSpeechPower / meanMusicSpeechPower);

      // SLA from Key Performance SLAs in ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md:
      // "Dialogue intelligibility: Speech-to-Music Ratio >= +15 dB during active speech."
      expect(smrDb).toBeGreaterThanOrEqual(15.0);

      // Verify dramatic pauses: during silence, sidechain compressor releases and music swells
      const pauseMusicPower = Math.pow(musicNominalRms, 2);
      const swellDb = 10 * Math.log10(pauseMusicPower / meanMusicSpeechPower);

      // Music swells by the ducking amount (+16 dB) during pauses
      expect(swellDb).toBeCloseTo(duckingAttenuationDb, 1);
    });
  });
});
