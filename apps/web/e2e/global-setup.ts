import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The renderer's runtime assets (`canvaskit.wasm`, the subset fonts) are copies,
 * not committed files, so a fresh checkout has none. Copying them here means the
 * e2e suite fails on a real bug rather than on a missing 404.
 */
export default function globalSetup(): void {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  execFileSync(process.execPath, [join(root, "scripts", "copy-render-assets.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
}
