import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { config as loadDotenvFile } from "dotenv";

/**
 * Load the nearest `.env` walking up from `startDir` to the filesystem root.
 *
 * The monorepo keeps a single `.env` at the repository root so every app, worker
 * and script sees the same values. Real environment variables always win, so a
 * container or CI runner overrides the file without editing it.
 *
 * @returns the path that was loaded, or `undefined` when no `.env` exists.
 */
export function loadRepoDotenv(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  const { root } = parse(dir);

  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      loadDotenvFile({ path: candidate, override: false, quiet: true });
      return candidate;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
