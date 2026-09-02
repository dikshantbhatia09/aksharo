import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A small, real, valid PCM WAV file for the upload e2e suite — generated on
 * the fly rather than checked in, so the repository never carries binary test
 * media. No `ffmpeg` dependency: a WAV header is simple enough to build by
 * hand (the same approach `apps/api/fixtures/sample-project`'s own generator
 * used), which keeps this suite reproducible on any machine that can run
 * Node, matching the brief's "small generated clip" (not the 40 MB multipart
 * fixture, which `lib/upload/multipart-upload.test.ts` already covers with
 * synthetic in-memory bytes — this one has to be a real file on disk for
 * Playwright's `setInputFiles`).
 */
export function generateWavFile(options: {
  readonly filename?: string;
  readonly seconds?: number;
  readonly sampleRate?: number;
}): string {
  const seconds = options.seconds ?? 3;
  const sampleRate = options.sampleRate ?? 8_000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const numSamples = Math.round(seconds * sampleRate);
  const dataSize = numSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.2 * 32767;
    buffer.writeInt16LE(Math.round(sample), 44 + i * blockAlign);
  }

  const dir = mkdtempSync(join(tmpdir(), "aksharo-e2e-"));
  const path = join(dir, options.filename ?? "clip.wav");
  writeFileSync(path, buffer);
  return path;
}
