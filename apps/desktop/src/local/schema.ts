/**
 * The local store's schema (brief C04 §1): four tables under the desktop's
 * SQLite database — projects, media, EDG v2 snapshots and exports. Local
 * mode is offline by design (brief: "no uploads of any kind"), so this file
 * has no foreign key ON DELETE behaviour that depends on a server; deletes
 * cascade in application code (`store.ts#deleteProject`) instead, which
 * keeps the on-disk media files (not SQLite's problem) and the rows in sync
 * in one place.
 *
 * `sql.js` speaks plain SQL, so this is the same schema a `better-sqlite3`
 * build would use — swapping the driver later (see `db.ts`'s doc comment)
 * needs no migration rewrite.
 */

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS local_projects (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     aspect TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS local_media (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     role TEXT NOT NULL,
     file_path TEXT NOT NULL,
     duration_ms INTEGER,
     fps REAL,
     width INTEGER,
     height INTEGER,
     imported_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS local_media_project_idx ON local_media(project_id)`,
  `CREATE TABLE IF NOT EXISTS local_edg_snapshots (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     doc TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS local_edg_snapshots_project_idx
     ON local_edg_snapshots(project_id, revision)`,
  `CREATE TABLE IF NOT EXISTS local_exports (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     output_path TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at TEXT NOT NULL,
     completed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS local_exports_project_idx ON local_exports(project_id)`,
];
