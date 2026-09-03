/**
 * Ingest an audio-pack manifest into `audio_assets` (D04a).
 *
 * ```
 * pnpm --filter @montaj/api ingest:audio-pack <manifest.json>
 * ```
 *
 * For each manifest asset: validate → measure loudness (ffmpeg `ebur128`) →
 * embed (CLAP via `worker-ai` when `CLAP_MODEL_PATH` is set, otherwise the
 * deterministic {@link StubEmbedder} — this machine has no model weights,
 * H-22) → upload the WAV to the derived bucket under
 * `packs/{packId}/{assetId}.wav` → upsert the row, idempotently, keyed on
 * `(provider, providerAssetId)`.
 *
 * Never touches the API's HTTP surface or BullMQ — this is an offline batch
 * tool run by whoever owns the pack, not a user-triggered job.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { newId } from "@montaj/edg";

import { AudioAssetsRepository } from "../src/audio-assets/audio-assets.repository.js";
import {
  ClapSubprocessEmbedder,
  StubEmbedder,
  type Embedder,
} from "../src/audio-assets/embedder.js";
import { measureIntegratedLoudness } from "../src/audio-assets/loudness.js";
import { validateManifest } from "../src/audio-assets/manifest.schema.js";
import { audioPackAssetKey } from "../src/audio-assets/pack-keys.js";
import { S3ObjectStore } from "../src/common/storage/s3-object-store.js";
import { loadRepoDotenv } from "../src/config/dotenv.js";

const API_DIR = resolve(__dirname, "..");

function requiredEnv(name: string): string {
  // eslint-disable-next-line security/detect-object-injection -- name is a fixed literal at every call site below, not attacker-controlled -- reviewed for D04a
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function buildDerivedStore(): S3ObjectStore {
  return new S3ObjectStore({
    kind: "r2",
    bucket: requiredEnv("R2_BUCKET_DERIVED"),
    endpoint: requiredEnv("R2_ENDPOINT"),
    region: process.env["S3_REGION"] ?? "auto",
    accessKeyId: requiredEnv("R2_ACCESS_KEY"),
    secretAccessKey: requiredEnv("R2_SECRET_KEY"),
  });
}

function buildEmbedder(): Embedder {
  const clapModelPath = process.env["CLAP_MODEL_PATH"];
  if (clapModelPath === undefined || clapModelPath === "") {
    console.warn(
      "[ingest-audio-pack] CLAP_MODEL_PATH not set — using the deterministic StubEmbedder (H-22: no model weights on this machine).",
    );
    return new StubEmbedder();
  }
  const workerAiCwd = resolve(API_DIR, "..", "worker-ai");
  return new ClapSubprocessEmbedder(process.env["PYTHON_BINARY"] ?? "python", workerAiCwd);
}

export async function ingestAudioPack(manifestPath: string): Promise<{
  readonly packId: string;
  readonly ingested: number;
  readonly created: number;
  readonly updated: number;
}> {
  const absoluteManifestPath = resolve(manifestPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an operator-supplied CLI argument to an offline batch tool, not attacker input -- reviewed for D04a
  if (!existsSync(absoluteManifestPath)) {
    throw new Error(`manifest not found: ${absoluteManifestPath}`);
  }
  const manifestDir = dirname(absoluteManifestPath);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same operator-supplied path as above -- reviewed for D04a
  const manifest = validateManifest(JSON.parse(readFileSync(absoluteManifestPath, "utf8")));

  const prisma = new PrismaClient();
  const repository = new AudioAssetsRepository(prisma);
  const store = buildDerivedStore();
  const embedder = buildEmbedder();
  const ffmpegBinary = process.env["FFMPEG_BINARY"] ?? "ffmpeg";

  let created = 0;
  let updated = 0;

  try {
    for (const asset of manifest.assets) {
      const filePath = resolve(manifestDir, asset.filePath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved against the operator-supplied manifest's own directory, not attacker input -- reviewed for D04a
      if (!existsSync(filePath)) {
        throw new Error(`asset ${asset.id}: file not found: ${filePath}`);
      }

      const loudness = await measureIntegratedLoudness({ ffmpegBinary, filePath });
      const embedding = await embedder.embed(filePath);
      const storageKey = audioPackAssetKey(manifest.pack.id, asset.id);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- same manifest-resolved path as above -- reviewed for D04a
      const body = readFileSync(filePath);
      await store.put({ key: storageKey, body, contentType: "audio/wav" });

      const { created: wasCreated } = await repository.upsertRow({
        id: newId(),
        packId: manifest.pack.id,
        asset,
        storageKey,
        integratedLufs: loudness.integratedLufs,
        truePeakDb: loudness.truePeakDb,
        durationMs: loudness.durationMs,
        embedding,
      });
      if (wasCreated) created += 1;
      else updated += 1;

      console.log(
        `[ingest-audio-pack] ${asset.id} (${asset.cueType ?? asset.kind}) → ${storageKey} ` +
          `(LUFS=${String(loudness.integratedLufs)}, ${wasCreated ? "created" : "updated"})`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  return { packId: manifest.pack.id, ingested: manifest.assets.length, created, updated };
}

async function main(): Promise<void> {
  loadRepoDotenv(API_DIR);
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    console.error("usage: ingest-audio-pack <manifest.json>");
    process.exit(1);
  }
  const result = await ingestAudioPack(manifestPath);
  console.log(
    `[ingest-audio-pack] pack ${result.packId}: ${String(result.ingested)} assets ` +
      `(${String(result.created)} created, ${String(result.updated)} updated)`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[ingest-audio-pack] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
