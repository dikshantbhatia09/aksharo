import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Marks `dist/esm` as ES modules.
 *
 * The package itself is CommonJS (the monorepo default, so NestJS and the
 * workers can `require` it), and `tsc` decides a file's format from the nearest
 * `package.json`. Dropping a `{"type":"module"}` marker beside the ESM output is
 * what makes the `import` condition of the exports map resolve to real ESM.
 *
 * Copied from `packages/fonts/scripts/finalise-esm-build.mjs`, which does the
 * same job for the same reason.
 */
const distEsm = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "esm");
mkdirSync(distEsm, { recursive: true });
writeFileSync(
  join(distEsm, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  "utf8",
);
console.log("build: marked dist/esm as ESM");
