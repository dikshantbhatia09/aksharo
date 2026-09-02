import { z } from "zod";

/**
 * The model/binary manifest (brief §3, H-22 pattern): every native binary and
 * model weight the engine needs comes from a versioned, SHA-256-verified
 * download rather than from anything committed to the repo (brief "Reality":
 * "never download model weights or native binaries into the repo"). This file
 * is data only — no network call, no filesystem access — so it can be unit
 * tested with an injected manifest and reused unchanged by `ModelManager` and
 * by C03b's real-hardware benchmarks.
 */

export const ManifestEntryKindSchema = z.enum([
  "asr",
  "asr-coreml",
  "vad",
  "denoise",
  "ffmpeg",
]);
export type ManifestEntryKind = z.infer<typeof ManifestEntryKindSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex digits");

export const ManifestEntrySchema = z.object({
  id: z.string().min(1),
  kind: ManifestEntryKindSchema,
  version: z.string().min(1),
  /** Path relative to `MODEL_WEIGHTS_BASE_URL`, e.g. `models/ggml-large-v3-turbo-q5_0.bin`. */
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  /** Platforms this entry applies to; omitted means every platform. */
  platforms: z.array(z.enum(["darwin", "win32", "linux"])).optional(),
  /** Only meaningful for `kind: "asr-coreml"`: needs a Metal-capable Apple Silicon Mac. */
  requiresCoreMl: z.boolean().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const EngineManifestSchema = z.object({
  v: z.literal(1),
  generatedAt: z.string().min(1),
  /** `ggml-large-v3-turbo-q5_0` (brief default) — must name an entry with `kind: "asr"`. */
  defaultAsrModel: z.string().min(1),
  /** `small-q5_1`-style fallback for weak machines — must also name an `"asr"` entry. */
  fallbackAsrModel: z.string().min(1),
  entries: z.array(ManifestEntrySchema).min(1),
});
export type EngineManifest = z.infer<typeof EngineManifestSchema>;

export class ManifestError extends Error {
  public override readonly name = "ManifestError";
}

export function parseManifest(raw: unknown): EngineManifest {
  const result = EngineManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`invalid engine manifest: ${result.error.message}`);
  }
  const manifest = result.data;
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (ids.has(entry.id)) throw new ManifestError(`manifest lists entry id "${entry.id}" twice`);
    ids.add(entry.id);
  }
  if (!ids.has(manifest.defaultAsrModel)) {
    throw new ManifestError(`defaultAsrModel "${manifest.defaultAsrModel}" is not a manifest entry`);
  }
  if (!ids.has(manifest.fallbackAsrModel)) {
    throw new ManifestError(`fallbackAsrModel "${manifest.fallbackAsrModel}" is not a manifest entry`);
  }
  return manifest;
}

/**
 * The default manifest (brief §1/§3): `ggml-large-v3-turbo-q5_0` (574 MB,
 * `05-system-architecture.md` §7) default, `small-q5_1` (190 MB) fallback,
 * Silero VAD, deep-filter, a CoreML encoder variant for macOS, and ffmpeg.
 * `sha256` values here are placeholders (`0` × 64) — a real manifest is
 * published to `MODEL_WEIGHTS_BASE_URL` and fetched at install time; nothing
 * with a real hash is ever committed to this repo (brief "Reality").
 */
export function defaultManifest(): EngineManifest {
  const placeholderSha256 = "0".repeat(64);
  return parseManifest({
    v: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    defaultAsrModel: "ggml-large-v3-turbo-q5_0",
    fallbackAsrModel: "ggml-small-q5_1",
    entries: [
      {
        id: "ggml-large-v3-turbo-q5_0",
        kind: "asr",
        version: "1.0.0",
        path: "models/ggml-large-v3-turbo-q5_0.bin",
        sizeBytes: 574_000_000,
        sha256: placeholderSha256,
      },
      {
        id: "ggml-small-q5_1",
        kind: "asr",
        version: "1.0.0",
        path: "models/ggml-small-q5_1.bin",
        sizeBytes: 190_000_000,
        sha256: placeholderSha256,
      },
      {
        id: "ggml-large-v3-turbo-encoder-coreml",
        kind: "asr-coreml",
        version: "1.0.0",
        path: "models/ggml-large-v3-turbo-encoder.mlmodelc.zip",
        sizeBytes: 60_000_000,
        sha256: placeholderSha256,
        platforms: ["darwin"],
        requiresCoreMl: true,
      },
      {
        id: "silero-vad",
        kind: "vad",
        version: "4.0.0",
        path: "models/silero_vad.onnx",
        sizeBytes: 2_200_000,
        sha256: placeholderSha256,
      },
      {
        id: "deep-filter",
        kind: "denoise",
        version: "0.5.6",
        path: "bin/deep-filter",
        sizeBytes: 12_000_000,
        sha256: placeholderSha256,
      },
      {
        id: "ffmpeg",
        kind: "ffmpeg",
        version: "7.1",
        path: "bin/ffmpeg",
        sizeBytes: 80_000_000,
        sha256: placeholderSha256,
      },
    ],
  });
}

/** Entries applicable on `platform`, in manifest order. */
export function entriesForPlatform(
  manifest: EngineManifest,
  platform: NodeJS.Platform,
): ManifestEntry[] {
  return manifest.entries.filter(
    (entry) => entry.platforms === undefined || entry.platforms.includes(platform as "darwin" | "win32" | "linux"),
  );
}
