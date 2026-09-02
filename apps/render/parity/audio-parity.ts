/**
 * Audio-track parity (B10b): the D33 tolerance section of the render README
 * covers *visual* browser-vs-cloud parity (A18a's SSIM gate over
 * `render-canvaskit` vs `render-skia-node` frames). This module is the audio
 * analogue for `audio.strategy: "replace"` — a manifest whose replacement
 * track comes from an `ai.clean` run (B10).
 *
 * The browser export path (`apps/web/lib/export/engine.ts`) reads the
 * cleaned track from `options.cleanAudioSource`, itself
 * `CreateExportResponse.sources.cleanedAudioUrl` — a signed GET built from
 * `AudioService`'s stored `storageKeys.cleanedAudioUrl`. The cloud render
 * path (`apps/render/src/render/pipeline.ts`) downloads the same track via
 * `derivedStore.download(manifest.audio.cleanKey, ...)`. Both ultimately name
 * the *same* object key — `exports.service.ts#resolveAudioClean` is the one
 * place that reads it off the `audio_cleans` row — but nothing before this
 * module verified the two paths actually receive byte-identical audio: a
 * signed-URL builder or a download helper drifting out of step with the
 * stored key would silently ship different audio per lane. `computeAudioParity`
 * hashes what each lane would fetch for the same manifest and reports a match.
 */

import { createHash } from "node:crypto";

import type { RenderManifest } from "@montaj/render-manifest";

/** Resolves the bytes a storage key names; swapped for a fake in tests. */
export type AudioObjectStore = (key: string) => Promise<Uint8Array>;

export interface AudioParityInput {
  readonly manifest: Pick<RenderManifest, "audio">;
  /** What `AudioService`/`exports.service.ts` signed into `sources.cleanedAudioUrl` for this export. */
  readonly cleanedAudioUrl: string;
  /** Resolves a signed URL to bytes, standing in for the browser's `fetch`. */
  readonly fetchBrowserSource: (url: string) => Promise<Uint8Array>;
  /** Resolves a storage key to bytes, standing in for `derivedStore.download`. */
  readonly resolveCloudSource: AudioObjectStore;
}

export interface AudioParityResult {
  readonly strategy: RenderManifest["audio"]["strategy"];
  /** `true` when `strategy` is not `"replace"` — there is no clean track to compare. */
  readonly skipped: boolean;
  readonly browserHash?: string;
  readonly cloudHash?: string;
  readonly match: boolean;
  readonly byteLength?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hashes the audio bytes the browser export path and the cloud render path
 * would each mux in for `audio.strategy: "replace"`, and reports whether they
 * match. A manifest with any other strategy has nothing to compare and comes
 * back `skipped: true, match: true` (vacuously — there is no clean track to
 * disagree about).
 */
export async function computeAudioParity(input: AudioParityInput): Promise<AudioParityResult> {
  const { manifest, cleanedAudioUrl, fetchBrowserSource, resolveCloudSource } = input;
  const { strategy, cleanKey } = manifest.audio;

  if (strategy !== "replace") {
    return { strategy, skipped: true, match: true };
  }
  if (cleanKey === undefined) {
    throw new Error(
      "audio.strategy is \"replace\" but the manifest carries no cleanKey — nothing to compare",
    );
  }

  const [browserBytes, cloudBytes] = await Promise.all([
    fetchBrowserSource(cleanedAudioUrl),
    resolveCloudSource(cleanKey),
  ]);

  const browserHash = sha256(browserBytes);
  const cloudHash = sha256(cloudBytes);

  return {
    strategy,
    skipped: false,
    browserHash,
    cloudHash,
    match: browserHash === cloudHash,
    byteLength: browserBytes.byteLength,
  };
}
