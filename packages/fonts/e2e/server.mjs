/**
 * The static server the browser loader runs against.
 *
 * It serves the **committed pack** under `/fonts/`, exactly as the API's
 * `GET /fonts/pack/{file}` does, plus the CanvasKit wasm and the bundled page.
 * No framework and no rewriting: the bytes the browser decompresses have to be
 * the bytes in the repository, or the test proves nothing.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packDir = resolve(here, "..", "pack");
const canvasKitBin = dirname(require.resolve("canvaskit-wasm/bin/canvaskit.js"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function resolvePath(url) {
  const path = url.split("?")[0];
  if (path === "/" || path === "/index.html") return join(here, "index.html");
  if (path === "/loader.js") return join(here, ".artifacts", "loader.js");
  if (path === "/commands.json") return join(here, ".artifacts", "commands.json");
  if (path === "/canvaskit.js") return join(canvasKitBin, "canvaskit.js");
  if (path === "/canvaskit.wasm") return join(canvasKitBin, "canvaskit.wasm");
  if (path.startsWith("/fonts/")) {
    const file = path.slice("/fonts/".length);
    if (file.includes("/") || file.includes("..")) return undefined;
    return join(packDir, file);
  }
  return undefined;
}

const port = Number(process.env.FONTS_E2E_PORT ?? 4321);

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
  // eslint-disable-next-line no-console -- this is a CLI harness; stdout is its status line.
  console.log(`fonts e2e harness on http://127.0.0.1:${port}`);
});
