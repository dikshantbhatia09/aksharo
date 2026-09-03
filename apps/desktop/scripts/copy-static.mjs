// tsc does not copy non-TS assets; the offline page's and the pairing
// approval window's HTML need to sit next to their compiled `.js` in dist/main.
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(join(root, "src", "main", "offline.html"), join(root, "dist", "main", "offline.html"));
copyFileSync(
  join(root, "src", "main", "pairing-approval.html"),
  join(root, "dist", "main", "pairing-approval.html"),
);

// The local store's SQLite engine (brief C04 §1, `src/local/db.ts`'s doc
// comment): `sql.js` ships its WASM binary inside its own package rather
// than as a native addon, so there is nothing for `scripts/bundle.mjs`'s
// esbuild `external` list to name — this is the one file that binary needs
// copied next to the bundled main entry point, never committed to the repo.
const require = createRequire(import.meta.url);
copyFileSync(
  require.resolve("sql.js/dist/sql-wasm.wasm"),
  join(root, "dist", "main", "sql-wasm.wasm"),
);
