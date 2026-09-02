/**
 * Audio decision tree (brief §3):
 *
 *   unmodified                        → packet copy (no AudioEncoder created)
 *   modified (cuts/clean) + AAC       → native encode
 *   modified, no AAC                  → `@mediabunny/aac-encoder` polyfill (lazy-loaded)
 *   modified, no AAC, polyfill fails  → cloud, with the credit cost
 *
 * "Modified" is the manifest's own call, not a re-derivation of it: `audio.strategy`
 * is `"replace"` whenever the manifest asks for the cleaned track, and the timemap
 * carries cuts whenever any accepted `cut` edit exists — both already decided
 * server-side (`manifest-builder.ts`) from the entitlement and the accepted items.
 * This module only walks the codec-availability half of the tree.
 */

import type { RenderManifest } from "@montaj/render-manifest";

import type { AudioStrategyDecision } from "./types";

export interface AudioDecisionInput {
  readonly manifest: RenderManifest;
  readonly aacEncodable: boolean;
  readonly aacPolyfillAvailable: boolean;
}

/** `true` when the manifest's timemap removes or retimes anything (cuts, speed, holds). */
export function timemapModifiesAudio(manifest: RenderManifest): boolean {
  return manifest.timemap.edits.length > 0;
}

/** `true` when this render is unmodified audio straight through: no edits, no clean-track swap. */
export function isAudioUnmodified(manifest: RenderManifest): boolean {
  return manifest.audio.strategy === "passthrough" && !timemapModifiesAudio(manifest);
}

export function decideAudioStrategy(input: AudioDecisionInput): AudioStrategyDecision {
  const { manifest, aacEncodable, aacPolyfillAvailable } = input;

  if (manifest.audio.strategy === "none") return { kind: "none" };

  if (isAudioUnmodified(manifest)) return { kind: "copy" };

  // Modified: cuts change packet timestamps even under "passthrough", and
  // "replace" always re-encodes the cleaned track — either way the container
  // needs freshly encoded AAC packets, not a copy of the source's.
  if (manifest.audio.codec === "aac" || manifest.audio.codec === "copy") {
    if (aacEncodable) return { kind: "encode", codec: "aac" };
    if (aacPolyfillAvailable) return { kind: "polyfill", codec: "aac" };
    return {
      kind: "cloud-required",
      reason:
        "This browser cannot encode AAC audio and the polyfill is unavailable. " +
        "Render in the cloud instead — the credit cost is shown below.",
    };
  }

  // pcm / opus: WebM/PCM containers are out of scope for the H.264/AAC MP4
  // path this brief specifies; treat as a cloud requirement rather than guess.
  return {
    kind: "cloud-required",
    reason: `The manifest asks for ${manifest.audio.codec} audio, which the browser path does not encode.`,
  };
}
