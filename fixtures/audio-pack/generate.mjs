#!/usr/bin/env node
/**
 * Generates the synthetic Tier 0 SFX fixture pack (D04a): a dozen short, tiny,
 * deterministic mono WAV cues across the taxonomy (09-ai-pipeline §6), plus
 * `manifest.json` describing each one with the typed licence fields the real
 * commissioned pack (A00-07) will carry through the same manifest shape.
 *
 * Every cue is pure sine-tone/noise synthesis (no external assets, no ffmpeg
 * needed to *generate* them — only to *measure* loudness during ingestion),
 * so the whole pack regenerates deterministically and stays a few hundred KB.
 *
 * Run: `node fixtures/audio-pack/generate.mjs`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wavDir = join(here, "wav");
mkdirSync(wavDir, { recursive: true });

const SAMPLE_RATE = 44_100;

/** A tiny mono 16-bit PCM WAV encoder — no dependency needed for fixtures. */
function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(
      Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))),
      44 + i * 2,
    );
  }
  return buffer;
}

function envelope(i, n, attack, release) {
  if (i < attack) return i / attack;
  if (i > n - release) return Math.max(0, (n - i) / release);
  return 1;
}

/** A short tone burst with an exponential-ish amplitude envelope. */
function tone(durationS, freqHz, { noiseMix = 0, sweepToHz, gain = 0.7 } = {}) {
  const n = Math.round(durationS * SAMPLE_RATE);
  const attack = Math.round(n * 0.05) || 1;
  const release = Math.round(n * 0.35) || 1;
  const samples = new Float64Array(n);
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const freq = sweepToHz !== undefined ? freqHz + (sweepToHz - freqHz) * (i / n) : freqHz;
    const tonal = Math.sin(2 * Math.PI * freq * t);
    const noise = rand();
    const env = envelope(i, n, attack, release);
    samples[i] = gain * env * (tonal * (1 - noiseMix) + noise * noiseMix);
  }
  return samples;
}

/**
 * The eight functional cue tags (09-ai-pipeline §6) — never meme names (D44).
 * At least one cue per tag; `impact`/`whoosh` get a second variant so the pack
 * totals a dozen, matching a small slice of the real commissioned taxonomy.
 */
const CUES = [
  {
    id: "sfx-impact-01",
    cueType: "impact",
    tags: ["impact", "hit", "punch"],
    mood: ["hard"],
    spec: () => tone(0.4, 90, { noiseMix: 0.3, gain: 0.9 }),
  },
  {
    id: "sfx-impact-02",
    cueType: "impact",
    tags: ["impact", "thud"],
    mood: ["soft"],
    spec: () => tone(0.5, 70, { noiseMix: 0.5, gain: 0.7 }),
  },
  {
    id: "sfx-whoosh-01",
    cueType: "whoosh",
    tags: ["whoosh", "swipe"],
    mood: ["fast"],
    spec: () => tone(0.6, 300, { sweepToHz: 60, noiseMix: 0.6, gain: 0.6 }),
  },
  {
    id: "sfx-whoosh-02",
    cueType: "whoosh",
    tags: ["whoosh", "transition"],
    mood: ["smooth"],
    spec: () => tone(0.8, 500, { sweepToHz: 120, noiseMix: 0.4, gain: 0.5 }),
  },
  {
    id: "sfx-pop-01",
    cueType: "pop",
    tags: ["pop", "click"],
    mood: ["light"],
    spec: () => tone(0.12, 1200, { gain: 0.8 }),
  },
  {
    id: "sfx-ding-01",
    cueType: "ding",
    tags: ["ding", "chime", "success"],
    mood: ["bright"],
    spec: () => tone(0.5, 1760, { gain: 0.6 }),
  },
  {
    id: "sfx-riser-01",
    cueType: "riser",
    tags: ["riser", "tension", "buildup"],
    mood: ["tense"],
    spec: () => tone(1.6, 110, { sweepToHz: 900, noiseMix: 0.2, gain: 0.55 }),
  },
  {
    id: "sfx-boom-01",
    cueType: "boom",
    tags: ["boom", "explosion", "impact"],
    mood: ["heavy"],
    spec: () => tone(0.9, 45, { noiseMix: 0.45, gain: 0.95 }),
  },
  {
    id: "sfx-comedic-01",
    cueType: "comedic",
    tags: ["comedic", "boing", "funny"],
    mood: ["playful"],
    spec: () => tone(0.45, 220, { sweepToHz: 440, gain: 0.6 }),
  },
  {
    id: "sfx-comedic-02",
    cueType: "comedic",
    tags: ["comedic", "slide-whistle", "funny"],
    mood: ["playful"],
    spec: () => tone(0.5, 800, { sweepToHz: 200, gain: 0.55 }),
  },
  {
    id: "sfx-notification-01",
    cueType: "notification",
    tags: ["notification", "alert", "message"],
    mood: ["neutral"],
    spec: () => tone(0.3, 1000, { gain: 0.5 }),
  },
  {
    id: "sfx-notification-02",
    cueType: "notification",
    tags: ["notification", "pop-up"],
    mood: ["neutral"],
    spec: () => tone(0.35, 1500, { gain: 0.5 }),
  },
];

const manifest = {
  pack: {
    id: "fixture-pack-01",
    owner: "montaj-fixtures",
    licenceRef: "fixtures/audio-pack/LICENCE-FIXTURE.txt",
    version: "0.1.0-fixture",
    kind: "sfx",
  },
  assets: CUES.map((cue) => {
    const samples = cue.spec();
    const wav = encodeWav(samples, SAMPLE_RATE);
    const filePath = `wav/${cue.id}.wav`;
    writeFileSync(join(here, filePath), wav);
    return {
      id: cue.id,
      kind: "sfx",
      cueType: cue.cueType,
      title: `Fixture ${cue.cueType} (${cue.id})`,
      tags: cue.tags,
      mood: cue.mood,
      filePath,
      // Licence fields — a wholly-owned fixture pack, so every gate opens
      // except the ones that would only ever be true for a commercially
      // licenced real pack (attribution, ai-training).
      provider: "owned",
      catalogueMode: "mirrored",
      licenceType: "work-for-hire",
      licensor: "montaj-fixtures",
      licenceRef: "fixtures/audio-pack/LICENCE-FIXTURE.txt",
      licenceVersion: "1",
      territory: ["WORLD"],
      allowsCommercialUse: true,
      allowsMonetisation: true,
      allowsPaidAds: true,
      allowsBroadcast: true,
      allowsRawFileDelivery: true,
      allowsOfflineCache: true,
      allowsEmbeddingIndex: true,
      allowsAiTraining: false,
      requiresAttribution: false,
      clearanceMethod: "none",
      contentIdRegistered: false,
      requiresUsageReport: false,
    };
  }),
};

writeFileSync(join(here, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(here, "LICENCE-FIXTURE.txt"),
  "Synthetic fixture audio generated for montaj D04a. Not for production use; " +
    "wholly-owned, generated tones — no third-party rights attach.\n",
);

console.log(`Generated ${manifest.assets.length} fixture cues into ${wavDir}`);
