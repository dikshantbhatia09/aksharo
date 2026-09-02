import { MigrationError, migrateV1ToV2 } from "./v1.js";
import { EDG_SCHEMA_VERSION } from "../schemas/document.js";
import { type EdgSnapshot, EdgSnapshotSchema } from "../schemas/snapshot.js";

/**
 * `@montaj/edg/migrations` — `meta.schemaVersion` migrations (D28).
 *
 * Migrations transform **snapshots**, never op logs: a revision's ops only ever
 * replay against a snapshot of their own generation, so a document is carried
 * forward by migrating its newest snapshot and starting a fresh log from there.
 */

/** One step of the chain. Steps are registered in ascending `from` order. */
export interface Migration {
  /** The `schemaVersion` this step reads. */
  readonly from: number;
  /** The `schemaVersion` it writes. */
  readonly to: number;
  /** Describes the change for operators reading a migration report. */
  readonly description: string;
  readonly migrate: (document: unknown) => unknown;
}

/** Every registered migration, ascending. */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    description:
      "flat word array with index-addressed segments becomes transcript chunks with stable word ids (D28)",
    migrate: migrateV1ToV2,
  },
];

/**
 * B10 encoded a clean run's id inside `audio.clean.preset` as
 * `"b10:<cleanId>"`, before `SetAudio.clean.cleanId` was a first-class field
 * (CONTRACTS §2, amended 2026-09-03 by B10b). Rewrites that interim form
 * in-place on a v2 document's hot state (and, if present, its projection) so
 * every loaded document reads `cleanId` directly; leaves everything else,
 * including any other `preset` value, untouched. Idempotent and a no-op on a
 * document with no such encoding.
 */
function normalizeAudioCleanPreset(document: unknown): unknown {
  if (typeof document !== "object" || document === null) return document;
  const record = document as Record<string, unknown>;
  const projection = record["projection"];
  if (typeof projection === "object" && projection !== null) {
    const next = normalizeAudioCleanInHot(projection as Record<string, unknown>);
    if (next !== projection) return { ...record, projection: next };
    return document;
  }
  // Bare EdgHot/EdgProjection document with no `projection` wrapper.
  if ("audio" in record || "meta" in record) {
    return normalizeAudioCleanInHot(record);
  }
  return document;
}

function normalizeAudioCleanInHot(hot: Record<string, unknown>): Record<string, unknown> {
  const audio = hot["audio"];
  if (typeof audio !== "object" || audio === null) return hot;
  const audioRecord = audio as Record<string, unknown>;
  const clean = audioRecord["clean"];
  if (typeof clean !== "object" || clean === null) return hot;
  const cleanRecord = clean as Record<string, unknown>;
  const preset = cleanRecord["preset"];
  if (typeof preset !== "string" || !preset.startsWith("b10:")) return hot;
  const cleanId = preset.slice("b10:".length);
  if (cleanId === "") return hot;
  const { preset: _preset, ...rest } = cleanRecord;
  return {
    ...hot,
    audio: {
      ...audioRecord,
      clean: { ...rest, cleanId },
    },
  };
}

/** The `schemaVersion` a stored document declares. */
export function schemaVersionOf(document: unknown): number {
  if (typeof document !== "object" || document === null) {
    throw new MigrationError("a migration input must be an object");
  }
  const record = document as Record<string, unknown>;
  const declared = record["schemaVersion"];
  if (typeof declared === "number") return declared;
  const meta = record["meta"];
  if (typeof meta === "object" && meta !== null) {
    const nested = (meta as Record<string, unknown>)["schemaVersion"];
    if (typeof nested === "number") return nested;
  }
  const projection = record["projection"];
  if (typeof projection === "object" && projection !== null) {
    return schemaVersionOf(projection);
  }
  throw new MigrationError("the document declares no schemaVersion");
}

/**
 * Carries a stored document forward to `targetVersion` (the current generation
 * by default), one registered step at a time, and validates the result.
 *
 * A document already at the target is parsed and returned; migrating backwards,
 * or across a version with no registered step, throws. `migrations` is only
 * passed by the tests that drive a deliberately broken step.
 */
export function migrate(
  document: unknown,
  targetVersion: number = EDG_SCHEMA_VERSION,
  migrations: readonly Migration[] = MIGRATIONS,
): EdgSnapshot {
  let version = schemaVersionOf(document);
  if (version > targetVersion) {
    throw new MigrationError(
      `cannot migrate a v${version} document down to v${targetVersion}; snapshots only move forward`,
    );
  }
  let current = document;
  while (version < targetVersion) {
    const step = migrations.find((migration) => migration.from === version);
    if (step === undefined) {
      throw new MigrationError(`no migration is registered from v${version}`);
    }
    current = step.migrate(current);
    version = step.to;
  }
  current = normalizeAudioCleanPreset(current);
  const parsed = EdgSnapshotSchema.safeParse(current);
  if (!parsed.success) {
    throw new MigrationError(
      `migration produced an invalid v${targetVersion} snapshot: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
