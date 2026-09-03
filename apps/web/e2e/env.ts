import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Read the repository `.env` the way the API does.
 *
 * Playwright does not load one, and the suite needs the same `DATABASE_URL`,
 * `REDIS_URL` and ports the API is running with — otherwise the test reads a
 * different Redis than the one the verification email was written to. Real
 * environment variables win, so CI can override without editing the file.
 */
export function loadRepoEnv(startDir: string = process.cwd()): Record<string, string> {
  const file = findEnvFile(startDir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const parsed = file === undefined ? {} : parseEnv(readFileSync(file, "utf8"));
  const merged: Record<string, string> = { ...parsed };
  for (const [key, value] of Object.entries(process.env)) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * The namespace every `montaj:`-style key the API writes lives under
 * (`apps/api/src/common/redis/redis-keys.ts`, `DEFAULT_REDIS_KEY_PREFIX`).
 *
 * Each worktree's `.env` sets `MONTAJ_REDIS_PREFIX` to its own work-package id
 * so suites sharing one Redis (A05/A23a) do not read or sweep each other's
 * keys. The e2e fixtures have to derive every Redis key they touch from the
 * same variable, or they poll a prefix the API never wrote to and every
 * sign-up fixture times out waiting for a message that already arrived under
 * a different key.
 */
export function redisKeyPrefix(env: Record<string, string>): string {
  const raw = env["MONTAJ_REDIS_PREFIX"]?.trim();
  return raw === undefined || raw === "" ? "montaj" : raw;
}

function findEnvFile(startDir: string): string | undefined {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A minimal `.env` parser: `KEY=value`, `#` comments, and double-quoted values
 * that may span lines (the PEM keys). Enough for what this repository writes,
 * and it avoids a dependency in a config file that has to load before anything.
 */
export function parseEnv(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(equals + 1);
    if (value.startsWith('"')) {
      // A quoted value may run over several lines (the RS256 PEMs do).
      let collected = value.slice(1);
      while (!collected.endsWith('"') && index + 1 < lines.length) {
        index += 1;
        // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
        collected += `\n${lines[index] ?? ""}`;
      }
      value = collected.replace(/"$/, "");
    } else {
      value = value.trim();
    }
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    result[key] = value;
  }

  return result;
}
