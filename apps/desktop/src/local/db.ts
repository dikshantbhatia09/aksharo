/**
 * The local store's SQLite handle (brief C04 §1).
 *
 * **Driver choice: `sql.js` (MIT), not `better-sqlite3`.** `better-sqlite3`
 * is a native addon: it needs a prebuilt binary for Electron's exact Node
 * ABI (or a full MSVC/Xcode toolchain to compile one), and — the brief's own
 * condition — would have to be added to `scripts/bundle.mjs`'s esbuild
 * `external` list and its compiled `.node` file copied into `dist/` by hand
 * for every target platform/arch electron-builder ships (win/mac/linux ×
 * x64/arm64). `sql.js` compiles SQLite to WebAssembly once, upstream, and
 * ships it as a single `.wasm` file that runs identically under Electron's
 * bundled Node with zero native compilation — `scripts/copy-static.mjs`
 * copies it next to `dist/main/index.js` exactly like `offline.html`
 * already is, and esbuild bundles the (pure-JS) loader inline like every
 * other pure-JS dependency in this app. The tradeoff, accepted here because
 * this store's rows are metadata only (media stays on disk as files, never
 * a BLOB): `sql.js` is an in-memory database with no built-in file journal,
 * so every mutation calls {@link persist} to serialise the whole (small —
 * kilobytes, not media-sized) database back to `local.sqlite3` — see
 * `store.ts`.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import { SCHEMA_STATEMENTS } from "./schema.js";

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

/**
 * Where the `.wasm` binary lives, never committed to the repo (it ships
 * inside the `sql.js` package itself, `node_modules/sql.js/dist/`). In the
 * packaged/bundled app, `scripts/copy-static.mjs` copies it next to the
 * bundled entry point at build time (`__dirname` is `dist/main` once
 * esbuild has bundled `src/main/index.ts` into one file — see
 * `scripts/bundle.mjs`); in dev/test (`tsx`/`vitest`, no bundling involved)
 * it is resolved straight out of `node_modules` instead.
 */
function locateSqlWasm(file: string): string {
  const bundled = path.join(__dirname, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (existsSync(bundled)) return bundled;
  return require.resolve(`sql.js/dist/${file}`);
}

/** Loads the `sql.js` WASM module once per process. */
function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({ locateFile: locateSqlWasm });
  return sqlJsPromise;
}

export interface LocalDb {
  readonly raw: Database;
  /** Serialises the whole database to `filePath` (atomic rename, same pattern as the model manager's downloads). */
  persist(): Promise<void>;
}

/**
 * Opens (or creates) the local database at `filePath`, applying the schema.
 * `filePath` is typically `app.getPath("userData")/local.sqlite3`, but a
 * test may point it anywhere, or open in pure memory (`:memory:`, never
 * persisted) for a scratch database.
 */
export async function openLocalDb(filePath: string): Promise<LocalDb> {
  const SQL = await loadSqlJs();
  const existing =
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    filePath === ":memory:" ? undefined : await readFile(filePath).catch(() => undefined);
  const raw = existing ? new SQL.Database(existing) : new SQL.Database();
  for (const statement of SCHEMA_STATEMENTS) raw.run(statement);

  return {
    raw,
    async persist() {
      if (filePath === ":memory:") return;
      const data = Buffer.from(raw.export());
      const tmp = `${filePath}.tmp-${String(process.pid)}`;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      await writeFile(tmp, data);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      await rename(tmp, filePath);
    },
  };
}
