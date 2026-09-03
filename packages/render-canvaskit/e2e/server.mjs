/**
 * The static server the browser test runs against.
 *
 * It exists because a `.wasm` and a font have to be same-origin, and because
 * the harness must serve exactly the bytes the Node baselines were drawn with —
 * the fixture fonts out of `@montaj/render-core`, the wasm out of
 * `canvaskit-wasm`, and the committed `commands.json`. No framework, no build:
 * a wrong file here would be a wrong test.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const canvasKitBin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));
const renderCoreFonts = resolve(
  dirname(require.resolve("@montaj/render-core/package.json")),
  "fixtures",
  "fonts",
);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

/** Every URL the harness may ask for, mapped to a file on disk. */
function resolvePath(url) {
  const path = url.split("?")[0];
  if (path === "/" || path === "/index.html") return join(here, "index.html");
  if (path === "/executor.js") return join(here, ".artifacts", "executor.js");
  if (path === "/canvaskit.js") return join(canvasKitBin, "canvaskit.js");
  if (path === "/canvaskit.wasm") return join(canvasKitBin, "canvaskit.wasm");
  if (path === "/commands.json") return join(packageRoot, "fixtures", "baselines", "commands.json");
  if (path.startsWith("/fonts/")) {
    const file = path.slice("/fonts/".length);
    if (file.includes("/") || file.includes("..")) return undefined;
    return join(renderCoreFonts, file);
  }
  return undefined;
}

const port = Number(process.env.RENDER_CANVASKIT_E2E_PORT ?? 4319);

const server = createServer((request, response) => {
  const file = resolvePath(request.url ?? "/");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (file === undefined || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`render-canvaskit e2e harness on http://127.0.0.1:${port}`);
});
