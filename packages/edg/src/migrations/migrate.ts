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
