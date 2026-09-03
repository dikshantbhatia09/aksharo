/**
 * Run `prisma generate`.
 *
 * Wired into `postinstall` and `build` (CONTRACTS §10 makes this A03's job): every
 * other package imports `@prisma/client`, and an ungenerated client is a type error
 * rather than a runtime one, so it has to happen before the first `tsc`.
 *
 * `prisma generate` reads the datasource block but never opens a connection. It
 * still refuses to run when `DATABASE_URL` is unset, which would break a fresh
 * `pnpm install` in CI (no `.env` there). A placeholder is therefore supplied when
 * the variable is missing — it is only ever parsed, never dialled.
 *
 * Plain `.mjs` and not TypeScript on purpose: `postinstall` may run before `tsx`
 * has been linked.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = "postgresql://prisma:prisma@localhost:5432/prisma?schema=public";

/** Read `DATABASE_URL` out of the nearest `.env`, without pulling in dotenv. */
function databaseUrlFromDotenv(startDir) {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    if (existsSync(candidate)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/m.exec(readFileSync(candidate, "utf8"));
      if (match?.[1]) return match[1].trim().replace(/^["']|["']$/g, "");
      return undefined;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const url = process.env.DATABASE_URL || databaseUrlFromDotenv(API_DIR) || PLACEHOLDER;

const result = spawnSync("prisma", ["generate"], {
  cwd: API_DIR,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
});

process.exit(result.status ?? 1);
