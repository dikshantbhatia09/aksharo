/**
 * Writes `apps/render/parity/results.json`'s `audio` block: the D33 tolerance
 * report's audio-track parity check (B10b), run against a fixture manifest
 * with `audio.strategy: "replace"` and an in-memory object store standing in
 * for the R2 bucket both `apps/web`'s browser export and `apps/render`'s
 * cloud pipeline read from. See `audio-parity.ts`'s doc comment for what this
 * actually verifies and why it matters.
 *
 * Run with `pnpm --filter @montaj/render exec tsx parity/run-audio-parity.ts`.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fixtureManifest } from "@montaj/render-manifest/testing";

import { computeAudioParity } from "./audio-parity";

const CLEAN_KEY = "clean/01JA20SNDTRACK000000000000.wav";
const SIGNED_URL = "https://storage.example.test/clean/01JA20SNDTRACK000000000000.wav?sig=fixture";

async function main(): Promise<void> {
  // A deterministic 48 kHz-ish byte pattern; only its hash matters here, not
  // its being playable audio — this checks byte-identity across the two
  // resolution paths, not the DSP chain (that is `worker_ai.clean`'s own
  // suite, `apps/worker-ai/tests/test_clean_dsp.py`).
  const bytes = new Uint8Array(4_096).map((_, i) => i % 256);

  const manifest = fixtureManifest({ audio: { strategy: "replace", cleanKey: CLEAN_KEY } });

  const result = await computeAudioParity({
    manifest,
    cleanedAudioUrl: SIGNED_URL,
    resolveCloudSource: (key) => {
      if (key !== CLEAN_KEY) throw new Error(`no object at ${key}`);
      return Promise.resolve(bytes);
    },
    fetchBrowserSource: (url) => {
      if (url !== SIGNED_URL) throw new Error(`no object signed for ${url}`);
      return Promise.resolve(bytes);
    },
  });

  const report = {
    generatedAt: new Date().toISOString(),
    audio: {
      description:
        'Browser-export vs cloud-render audio-track hash comparison for audio.strategy: "replace" (B10b).',
      strategy: result.strategy,
      match: result.match,
      browserHash: result.browserHash,
      cloudHash: result.cloudHash,
      byteLength: result.byteLength,
    },
  };

  const path = join(__dirname, "results.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`audio parity: wrote ${path} (match: ${String(result.match)})`);
}

void main();
