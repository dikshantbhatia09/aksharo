/**
 * D04e-3's fixture clip: 6 seconds, three accepted `sfx` cues over a silent
 * base — one with a fade (the "ding"), one under a speech range to exercise
 * the duck curve (the "whoosh"), and one plain (the "pop") — per the WP
 * brief's own description of the envelope-parity fixture. Assets come from
 * `fixtures/audio-pack/wav/`, the same fixture pack `apps/api/src/
 * audio-assets` and `run-sfx-parity.ts` already use.
 */

import { join } from "node:path";

export const CLIP_DURATION_MS = 6_000;
export const SAMPLE_RATE = 48_000;

function wav(name: string): string {
  return join(__dirname, "..", "..", "..", "fixtures", "audio-pack", "wav", `${name}.wav`);
}

export interface AudioMixFixtureCue {
  readonly itemId: string;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly gainDb: number;
  readonly fadeInMs: number;
  readonly fadeOutMs: number;
  readonly duck: {
    readonly depthDb: number;
    readonly attackMs: number;
    readonly releaseMs: number;
  } | null;
  readonly localPath: string;
}

/** A wide-open speech range covering most of the "whoosh" cue's window, so
 * its duck curve actually dips — the fixture's "cue under speech" case. */
export const AUDIO_MIX_SPEECH_RANGES: readonly { startMs: number; endMs: number }[] = [
  { startMs: 2_600, endMs: 4_000 },
];

export const AUDIO_MIX_FIXTURE_CUES: readonly AudioMixFixtureCue[] = [
  {
    itemId: "01JD04EPARDNG000000000000",
    label: "ding — a 500ms cue with a 50ms fade in/out",
    startMs: 500,
    endMs: 1_000,
    gainDb: 0,
    fadeInMs: 50,
    fadeOutMs: 50,
    duck: null,
    localPath: wav("sfx-ding-01"),
  },
  {
    itemId: "01JD04EPARWSH000000000000",
    label: "whoosh — a 600ms cue ducked -12dB under speech",
    startMs: 2_500,
    endMs: 3_100,
    gainDb: -3,
    fadeInMs: 0,
    fadeOutMs: 0,
    duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
    localPath: wav("sfx-whoosh-01"),
  },
  {
    itemId: "01JD04EPARPOP000000000000",
    label: "pop — a plain 120ms cue, no fade or duck",
    startMs: 5_000,
    endMs: 5_120,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    duck: null,
    localPath: wav("sfx-pop-01"),
  },
];
