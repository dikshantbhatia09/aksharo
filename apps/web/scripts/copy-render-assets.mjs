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
 *
 * A14 adds the style catalogue's static previews for the same reason: the Home
 * quick-pick and any other lightweight style tile read
 * `/style-previews/<key>.png` from this app's own origin rather than running
 * the full CanvasKit renderer just to draw a thumbnail. Missing previews (a
 * style `previews:build` has not rendered yet) are skipped, not fatal — the
 * web app already treats a `null` `previewKey` as "no static preview yet".
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The condensed display face used by editorial typography, shared with export.
mkdirSync(join(root, "public", "fonts"), { recursive: true });
copyFileSync(
  require.resolve("@montaj/fonts/pack/anton-400.ttf"),
  join(root, "public", "fonts", "anton-400.ttf"),
);

// Every other bundled-catalogue face the font picker (`RightPanel.tsx`'s
// `CATALOGUE`-driven Font Family list) can already offer but `use-canvaskit.ts`
// could not yet draw before this pass — picking one of these from the picker
// used to silently fall back to whichever registered face happened to cover
// the same code points. `anton-400` above predates this and stays a separate,
// explicit copy since export's font-pack story (`RENDER_FONT_DIR`) already
// depends on that exact call.
for (const file of [
  "montserrat-400.ttf",
  "montserrat-600.ttf",
  "montserrat-800.ttf",
  "montserrat-900.ttf",
  "poppins-400.ttf",
  "poppins-700.ttf",
  "poppins-800.ttf",
  "roboto-mono-500.ttf",
  "roboto-mono-700.ttf",
  "bricolage-grotesque-700.ttf",
  "bricolage-grotesque-800.ttf",
  "jetbrains-mono-400.ttf",
  "jetbrains-mono-700.ttf",
  "oswald-400.ttf",
  "oswald-700.ttf",
  "raleway-400.ttf",
  "raleway-700.ttf",
  "nunito-400.ttf",
  "nunito-700.ttf",
  "dm-sans-400.ttf",
  "dm-sans-700.ttf",
  "bebas-neue-400.ttf",
  "black-ops-one-400.ttf",
  "bungee-400.ttf",
  "bangers-400.ttf",
  "pacifico-400.ttf",
  "caveat-400.ttf",
  "caveat-700.ttf",
  "dancing-script-400.ttf",
  "dancing-script-700.ttf",
  "permanent-marker-400.ttf",
  "satisfy-400.ttf",
  "noto-sans-bengali-400.ttf",
  "noto-sans-bengali-700.ttf",
  "noto-sans-gurmukhi-400.ttf",
  "noto-sans-gurmukhi-700.ttf",
  "noto-sans-gujarati-400.ttf",
  "noto-sans-gujarati-700.ttf",
  "noto-sans-oriya-400.ttf",
  "noto-sans-oriya-700.ttf",
  "noto-sans-telugu-400.ttf",
  "noto-sans-telugu-700.ttf",
  "noto-sans-kannada-400.ttf",
  "noto-sans-kannada-700.ttf",
  "noto-sans-malayalam-400.ttf",
  "noto-sans-malayalam-700.ttf",
  "noto-sans-ol-chiki-400.ttf",
  "noto-sans-ol-chiki-700.ttf",
  "noto-sans-meetei-mayek-400.ttf",
  "noto-sans-meetei-mayek-700.ttf",
  "noto-sans-arabic-400.ttf",
  "noto-sans-arabic-700.ttf",
]) {
  copyFileSync(require.resolve(`@montaj/fonts/pack/${file}`), join(root, "public", "fonts", file));
}

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
const previewsDir = resolve(
  dirname(require.resolve("@montaj/caption-styles/package.json")),
  "previews",
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

// eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
if (existsSync(previewsDir)) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  for (const file of readdirSync(previewsDir).filter((name) => name.endsWith(".png"))) {
    targets.push({
      from: join(previewsDir, file),
      to: join(root, "public", "style-previews", file),
    });
  }
}

for (const target of targets) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  mkdirSync(dirname(target.to), { recursive: true });
  copyFileSync(target.from, target.to);
  console.log(`copied ${target.to.slice(root.length + 1)}`);
}
