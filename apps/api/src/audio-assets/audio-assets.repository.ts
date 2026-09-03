import { Inject, Injectable } from "@nestjs/common";
import {
  Prisma,
  type AudioProvider,
  type ClearanceMethod,
  type PrismaClient,
} from "@prisma/client";

import { PrismaService } from "../common/prisma/prisma.service.js";

import type { ManifestAsset } from "./manifest.schema.js";

/** The subset of Prisma's client this repository needs — satisfied by both the
 * injectable {@link PrismaService} and a bare `PrismaClient` (the ingest CLI,
 * which runs outside Nest's DI container). */
export type AudioAssetsPrisma = Pick<PrismaClient, "audioAsset" | "$executeRaw" | "$queryRaw">;

/** What ingestion has measured/computed for one manifest asset, ready to write. */
export interface IngestRow {
  readonly id: string;
  readonly packId: string;
  readonly asset: ManifestAsset;
  readonly storageKey: string;
  readonly integratedLufs: number | null;
  readonly truePeakDb: number | null;
  readonly durationMs: number | null;
  /** 512-dim CLAP embedding (or the deterministic stub in fixture/test mode). */
  readonly embedding: readonly number[];
}

function toVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length !== 512) {
    throw new Error(`embedding must be 512-dimensional, received ${embedding.length}`);
  }
  return `[${embedding.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

/**
 * Ingestion writes (`upsertRow`) and pass-time reads (`findAllowedByKind`) over
 * `audio_assets`. `embedding` is `Unsupported("vector(512)")` in the Prisma
 * schema (D44) — invisible to the generated client — so both directions use
 * raw SQL for that one column, exactly as `0004-comments.sql` documents.
 */
@Injectable()
export class AudioAssetsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: AudioAssetsPrisma) {}

  /**
   * Idempotent by `(provider, providerAssetId)` (the schema's unique
   * constraint) — `providerAssetId` is `{packId}:{manifest asset id}`, so
   * re-running the CLI against the same manifest updates rows in place
   * instead of duplicating them.
   */
  async upsertRow(row: IngestRow): Promise<{ readonly id: string; readonly created: boolean }> {
    const providerAssetId = `${row.packId}:${row.asset.id}`;
    const vector = toVectorLiteral(row.embedding);

    const existing = await this.prisma.audioAsset.findUnique({
      where: { provider_providerAssetId: { provider: row.asset.provider, providerAssetId } },
      select: { id: true },
    });
    const id = existing?.id ?? row.id;

    await this.prisma.$executeRaw`
      INSERT INTO audio_assets (
        id, kind, provider, provider_asset_id, catalogue_mode,
        licence_type, licensor, licence_ref, licence_version, territory,
        term_start, term_end,
        allows_commercial_use, allows_monetisation, allows_paid_ads, allows_broadcast,
        allows_raw_file_delivery, allows_offline_cache, allows_embedding_index, allows_ai_training,
        requires_attribution, attribution_text, clearance_method, content_id_registered,
        requires_usage_report, report_endpoint,
        title, tags, mood, cue_type, bpm, musical_key,
        integrated_lufs, true_peak_db, duration_ms, storage_key, embedding,
        created_at, updated_at
      ) VALUES (
        ${id}, ${row.asset.kind}::"AudioAssetKind", ${row.asset.provider}::"AudioProvider",
        ${providerAssetId}, ${row.asset.catalogueMode}::"CatalogueMode",
        ${row.asset.licenceType ?? null}, ${row.asset.licensor ?? null}, ${row.asset.licenceRef ?? null},
        ${row.asset.licenceVersion ?? null}, ${row.asset.territory},
        ${row.asset.termStart ? new Date(row.asset.termStart) : null},
        ${row.asset.termEnd ? new Date(row.asset.termEnd) : null},
        ${row.asset.allowsCommercialUse}, ${row.asset.allowsMonetisation}, ${row.asset.allowsPaidAds},
        ${row.asset.allowsBroadcast}, ${row.asset.allowsRawFileDelivery}, ${row.asset.allowsOfflineCache},
        ${row.asset.allowsEmbeddingIndex}, ${row.asset.allowsAiTraining},
        ${row.asset.requiresAttribution}, ${row.asset.attributionText ?? null},
        ${row.asset.clearanceMethod}::"ClearanceMethod", ${row.asset.contentIdRegistered},
        ${row.asset.requiresUsageReport}, ${row.asset.reportEndpoint ?? null},
        ${row.asset.title}, ${row.asset.tags}, ${row.asset.mood}, ${row.asset.cueType ?? null},
        ${row.asset.bpm ?? null}, ${row.asset.musicalKey ?? null},
        ${row.integratedLufs}, ${row.truePeakDb}, ${row.durationMs}, ${row.storageKey},
        ${vector}::vector(512), now(), now()
      )
      ON CONFLICT (provider, provider_asset_id) DO UPDATE SET
        catalogue_mode = EXCLUDED.catalogue_mode,
        licence_type = EXCLUDED.licence_type,
        licensor = EXCLUDED.licensor,
        licence_ref = EXCLUDED.licence_ref,
        licence_version = EXCLUDED.licence_version,
        territory = EXCLUDED.territory,
        term_start = EXCLUDED.term_start,
        term_end = EXCLUDED.term_end,
        allows_commercial_use = EXCLUDED.allows_commercial_use,
        allows_monetisation = EXCLUDED.allows_monetisation,
        allows_paid_ads = EXCLUDED.allows_paid_ads,
        allows_broadcast = EXCLUDED.allows_broadcast,
        allows_raw_file_delivery = EXCLUDED.allows_raw_file_delivery,
        allows_offline_cache = EXCLUDED.allows_offline_cache,
        allows_embedding_index = EXCLUDED.allows_embedding_index,
        allows_ai_training = EXCLUDED.allows_ai_training,
        requires_attribution = EXCLUDED.requires_attribution,
        attribution_text = EXCLUDED.attribution_text,
        clearance_method = EXCLUDED.clearance_method,
        content_id_registered = EXCLUDED.content_id_registered,
        requires_usage_report = EXCLUDED.requires_usage_report,
        report_endpoint = EXCLUDED.report_endpoint,
        title = EXCLUDED.title,
        tags = EXCLUDED.tags,
        mood = EXCLUDED.mood,
        cue_type = EXCLUDED.cue_type,
        bpm = EXCLUDED.bpm,
        musical_key = EXCLUDED.musical_key,
        integrated_lufs = EXCLUDED.integrated_lufs,
        true_peak_db = EXCLUDED.true_peak_db,
        duration_ms = EXCLUDED.duration_ms,
        storage_key = EXCLUDED.storage_key,
        embedding = EXCLUDED.embedding,
        updated_at = now()
    `;

    return { id, created: existing === undefined || existing === null };
  }

  /**
   * Every `sfx` (or `music`) asset whose licence predicate *could* allow it
   * (surface/plan/clearance still checked in TS by `assetAllowed` — this
   * query only pre-filters on what SQL can index cheaply: kind and
   * embedding-index eligibility), ranked by CLAP cosine similarity to
   * `queryEmbedding` (pgvector `<=>`, ascending = most similar first).
   */
  async findRankedByEmbedding(input: {
    readonly kind: "sfx" | "music";
    readonly queryEmbedding: readonly number[];
    readonly limit?: number;
  }): Promise<
    Array<{
      readonly id: string;
      readonly provider: AudioProvider;
      readonly territory: string[];
      readonly termStart: Date | null;
      readonly termEnd: Date | null;
      readonly allowsRawFileDelivery: boolean;
      readonly clearanceMethod: ClearanceMethod;
      readonly cueType: string | null;
      readonly tags: string[];
      readonly mood: string[];
      readonly storageKey: string | null;
      readonly distance: number;
    }>
  > {
    const vector = toVectorLiteral(input.queryEmbedding);
    const limit = input.limit ?? 20;

    return this.prisma
      .$queryRaw<
        Array<{
          id: string;
          provider: AudioProvider;
          territory: string[];
          term_start: Date | null;
          term_end: Date | null;
          allows_raw_file_delivery: boolean;
          clearance_method: ClearanceMethod;
          cue_type: string | null;
          tags: string[];
          mood: string[];
          storage_key: string | null;
          distance: number;
        }>
      >(
        Prisma.sql`
      SELECT id, provider, territory, term_start, term_end, allows_raw_file_delivery,
             clearance_method, cue_type, tags, mood, storage_key,
             (embedding <=> ${vector}::vector(512)) AS distance
      FROM audio_assets
      WHERE kind = ${input.kind}::"AudioAssetKind" AND allows_embedding_index = true
      ORDER BY distance ASC, id ASC
      LIMIT ${limit}
    `,
      )
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          territory: row.territory,
          termStart: row.term_start,
          termEnd: row.term_end,
          allowsRawFileDelivery: row.allows_raw_file_delivery,
          clearanceMethod: row.clearance_method,
          cueType: row.cue_type,
          tags: row.tags,
          mood: row.mood,
          storageKey: row.storage_key,
          distance: Number(row.distance),
        })),
      );
  }
}
