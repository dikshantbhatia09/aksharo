/**
 * Copies the renderer's runtime assets into `public/`.
 *
 * `canvaskit.wasm` and the subset fonts must be served from the app's own
 * origin: a cross-origin `.wasm` fetch fails under the app's CSP, and a font
 * the layout engine cannot read is a caption that does not draw. Run it once
 * after `pnpm install` and again whenever `canvaskit-wasm` moves:
 *
 *   pnpm --filter @montaj/web assets:render
 *
 * A18b replaces the fixture fonts here with the real subset faces served from
 * R2; the paths the components fetch (`/canvaskit/`, `/fonts/`) do not change.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `canvaskit-wasm` belongs to `@montaj/render-canvaskit`, not to the app, and
// pnpm's strict layout means it is only resolvable from there.
const backendRoot = dirname(require.resolve("@montaj/render-canvaskit/package.json"));
const canvasKitBin = dirname(
  require.resolve("canvaskit-wasm/bin/canvaskit.js", { paths: [backendRoot] }),
);
const fontDir = resolve(
  dirname(require.resolve("@montaj/render-core/package.json")),
  "fixtures",
  "fonts",
);

const targets = [
  {
    from: join(canvasKitBin, "canvaskit.wasm"),
    to: join(root, "public", "canvaskit", "canvaskit.wasm"),
  },
  ...[
    "NotoSans-Regular-subset.ttf",
    "NotoSansDevanagari-Regular-subset.ttf",
    "NotoSansTamil-Regular-subset.ttf",
  ].map((file) => ({ from: join(fontDir, file), to: join(root, "public", "fonts", file) })),
];

for (const target of targets) {
  mkdirSync(dirname(target.to), { recursive: true });
  copyFileSync(target.from, target.to);
  console.log(`copied ${target.to.slice(root.length + 1)}`);
}
