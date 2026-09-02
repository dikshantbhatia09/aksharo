/**
 * A valid manifest to start from.
 *
 * Exported from the package (not only from its tests) because `apps/render`
 * builds every one of its fixtures on top of this one: a manifest has twenty
 * required fields and a test that spells them all out tests the typist, not the
 * renderer.
 */

import { type RenderManifest, type UnsignedRenderManifest } from "./schema.js";
import { withSignature } from "./signature.js";

/**
 * ULIDs that are stable across runs, so a golden file may contain them.
 *
 * Crockford base32 has no `I`, `L`, `O` or `U`, which is why these read like
 * vanity plates: they have to be mnemonic *and* parse as real ids.
 */
export const FIXTURE_IDS = Object.freeze({
  workspaceId: "01JA20WKSPACE0000000000000",
  projectId: "01JA20PRJECT00000000000000",
  exportId: "01JA20EXPRT000000000000000",
  manifestId: "01JA20MANFEST0000000000000",
  edgId: "01JA20EDG00000000000000000",
  transcriptId: "01JA20TRANSCRPT00000000000",
  mediaId: "01JA20MEDA0000000000000000",
  cleanId: "01JA20SNDTRACK000000000000",
});

/** Deep-merges the overrides one level down, which is all the fixtures need. */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

/**
 * An unsigned 1080×1920 H.264 manifest with a watermark and generous caps.
 * Override any top-level field; nested objects merge one level.
 */
export function fixtureManifest(
  overrides: DeepPartial<UnsignedRenderManifest> = {},
  now = Date.parse("2026-09-02T09:00:00.000Z"),
): UnsignedRenderManifest {
  const base: UnsignedRenderManifest = {
    v: 1,
    manifestId: FIXTURE_IDS.manifestId,
    nonce: "0123456789abcdef0123456789abcdef",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    workspaceId: FIXTURE_IDS.workspaceId,
    projectId: FIXTURE_IDS.projectId,
    exportId: FIXTURE_IDS.exportId,
    edg: { edgId: FIXTURE_IDS.edgId, revision: 7, transcriptId: FIXTURE_IDS.transcriptId },
    styles: {
      // A real id from the system catalogue: a fixture naming a style nobody
      // ships fails deep inside layout, a long way from here.
      defaultStyleId: "punch-pop",
      catalogueSnapshotIds: ["punch-pop@0f1e2d3c"],
    },
    source: {
      mediaId: FIXTURE_IDS.mediaId,
      bucket: "raw",
      key: `ws/${FIXTURE_IDS.workspaceId}/p/${FIXTURE_IDS.projectId}/media/${FIXTURE_IDS.mediaId}/raw.mp4`,
      durationMs: 10_000,
      width: 1080,
      height: 1920,
      fps: 30,
    },
    timemap: { sourceDurationMs: 10_000, edits: [], snapCutsToFrames: false },
    output: {
      kind: "video",
      preset: "reels",
      aspect: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      container: "mp4",
      videoCodec: "h264",
      crf: 20,
      encoderPreset: "veryfast",
    },
    audio: { strategy: "passthrough", codec: "aac", bitrateKbps: 192 },
    watermark: { assetId: "aksharo-watermark", position: "bottom-right", opacity: 0.85 },
    caps: {
      maxWidth: 1920,
      maxHeight: 1920,
      maxDurationMs: 20 * 60_000,
      maxFps: 60,
      allowAlpha: false,
    },
    subtitles: null,
    renderCoreVersion: "0.1.0",
  };
  return mergeOneLevel(base, overrides);
}

/** {@link fixtureManifest}, signed with `secret`. */
export function signedFixtureManifest(
  secret: string,
  overrides: DeepPartial<UnsignedRenderManifest> = {},
  now?: number,
): RenderManifest {
  return withSignature(fixtureManifest(overrides, now), secret);
}

function mergeOneLevel(
  base: UnsignedRenderManifest,
  overrides: DeepPartial<UnsignedRenderManifest>,
): UnsignedRenderManifest {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = merged[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      merged[key] = { ...(current as Record<string, unknown>), ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged as unknown as UnsignedRenderManifest;
}
