import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Marks `dist/esm` as ES modules (same trick as `packages/timemap`'s build: `tsc` decides a
 * file's format from the nearest `package.json`, and this package itself is CommonJS so
 * NestJS-less consumers and the plugin bundlers can both resolve it).
 */
const distEsm = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "esm");
mkdirSync(distEsm, { recursive: true });
writeFileSync(
  join(distEsm, "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
  "utf8",
);
console.log("build: marked dist/esm as ESM");
