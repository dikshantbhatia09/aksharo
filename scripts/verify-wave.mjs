#!/usr/bin/env node
/**
 * Wave verification script (A23 brief item 5; `docs/PLAN.md`'s "Verification
 * gate procedure"): fresh clone -> install -> compose up -> migrate/seed ->
 * unit tests -> e2e -> parity gate -> collect screenshots -> write
 * `docs/verification/<date>-<wave>.md`.
 *
 * Cross-platform (Node, not bash — `05-build`'s Windows-host rule). Every
 * step runs from the temp clone except the two whose whole point is to
 * touch the shared Docker stack and the ORIGINAL repo's own
 * `docs/verification/`: the summary is written back into the repo this
 * script was invoked from (not the throwaway clone), so it survives after
 * the temp directory is removed.
 *
 * Usage: node scripts/verify-wave.mjs --wave <n> [--keep-clone] [--skip <step,step>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { wave: null, keepClone: false, skip: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--wave") args.wave = argv[++i];
    else if (argv[i] === "--keep-clone") args.keepClone = true;
    else if (argv[i] === "--skip")
      args.skip = new Set((argv[++i] ?? "").split(",").filter(Boolean));
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.wave === null) {
  console.error("usage: node scripts/verify-wave.mjs --wave <n>");
  process.exit(1);
}

const results = [];

function run(name, command, cmdArgs, options = {}) {
  if (args.skip.has(name)) {
    results.push({ name, status: "skipped", durationMs: 0, detail: "--skip" });
    console.log(`[verify-wave] SKIP  ${name}`);
    return { status: 0 };
  }
  console.log(`[verify-wave] RUN   ${name}: ${command} ${cmdArgs.join(" ")}`);
  const start = Date.now();
  const result = spawnSync(command, cmdArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  const durationMs = Date.now() - start;
  const ok = result.status === 0;
  results.push({
    name,
    status: ok ? "pass" : "fail",
    durationMs,
    detail: ok ? "" : `exit ${String(result.status ?? result.signal ?? "unknown")}`,
  });
  console.log(
    `[verify-wave] ${ok ? "PASS" : "FAIL"}  ${name} (${(durationMs / 1000).toFixed(1)}s)`,
  );
  return result;
}

/**
 * Copies `.env.example`, generates a fresh RS256 keypair (same shape
 * `docs/CONTRACTS.md`'s example uses) and points every port/host at the
 * `docker-compose.test.yml` stack's exposed ports — the same values
 * `.github/workflows/e2e.yml`'s "Write a CI .env" step writes, so a local
 * `verify-wave` run and CI's exercise the same compose file the same way.
 */
function writeCloneEnv(cloneDir) {
  const examplePath = join(cloneDir, ".env.example");
  let env = readFileSync(examplePath, "utf8");

  const privateKey = execFileSync("openssl", [
    "genpkey",
    "-algorithm",
    "RSA",
    "-pkeyopt",
    "rsa_keygen_bits:2048",
  ]).toString();
  const publicKey = execFileSync("openssl", ["rsa", "-pubout"], { input: privateKey }).toString();

  const replacements = {
    DATABASE_URL: "postgresql://montaj:montaj@127.0.0.1:59432/montaj_e2e?schema=public",
    REDIS_URL: "redis://127.0.0.1:59379",
    S3_ENDPOINT: "http://127.0.0.1:59000",
    R2_ENDPOINT: "http://127.0.0.1:59000",
    S3_ACCESS_KEY: "montaj-e2e",
    S3_SECRET_KEY: "montaj-e2e-secret",
    R2_ACCESS_KEY: "montaj-e2e",
    R2_SECRET_KEY: "montaj-e2e-secret",
    API_ORIGIN: "http://127.0.0.1:59923",
    WEB_ORIGIN: "http://127.0.0.1:59924",
    API_PORT: "59923",
    WEB_PORT: "59924",
    INTERNAL_CALLBACK_SECRET: "verify-wave-internal-callback-secret",
    LLM_PROVIDER: "mock",
  };
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : `${env}\n${key}=${value}\n`;
  }
  // `.env.example`'s JWT keys are one line each, `\n` escaped literally
  // (`packages/config/src/env.ts`'s `unescapeNewlines` turns it back into a
  // real PEM at load time) — not the multi-line quoted form a worktree's own
  // `.env` uses.
  const escapedPrivate = privateKey.trim().replace(/\r?\n/g, "\\n");
  const escapedPublic = publicKey.trim().replace(/\r?\n/g, "\\n");
  env = env.replace(/^JWT_PRIVATE_KEY=.*$/m, `JWT_PRIVATE_KEY="${escapedPrivate}"`);
  env = env.replace(/^JWT_PUBLIC_KEY=.*$/m, `JWT_PUBLIC_KEY="${escapedPublic}"`);

  writeFileSync(join(cloneDir, ".env"), env, "utf8");
}

function fmtDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const overallStart = Date.now();

  // --- 1. Fresh clone into a temp dir -------------------------------------
  const cloneDir = mkdtempSync(join(tmpdir(), "montaj-verify-wave-"));
  console.log(`[verify-wave] cloning ${REPO_ROOT} -> ${cloneDir}`);
  const cloneStart = Date.now();
  const cloneResult = spawnSync("git", ["clone", "--local", REPO_ROOT, cloneDir], {
    stdio: "inherit",
  });
  results.push({
    name: "fresh clone",
    status: cloneResult.status === 0 ? "pass" : "fail",
    durationMs: Date.now() - cloneStart,
    detail: cloneResult.status === 0 ? "" : `exit ${String(cloneResult.status)}`,
  });
  if (cloneResult.status !== 0) {
    await writeSummary(overallStart);
    process.exit(1);
  }

  const runInClone = (name, command, cmdArgs) => run(name, command, cmdArgs, { cwd: cloneDir });

  // --- 2. Install ----------------------------------------------------------
  const install = runInClone("pnpm install", "pnpm", ["install", "--frozen-lockfile"]);
  if (install.status !== 0) {
    await writeSummary(overallStart, cloneDir);
    if (!args.keepClone) rmSync(cloneDir, { recursive: true, force: true });
    process.exit(1);
  }

  // --- 2.5. Write a .env for the clone -------------------------------------
  // A fresh clone has no `.env` (gitignored). `docker-compose.test.yml`'s
  // api/web containers hard-code their own DATABASE_URL/REDIS_URL etc.
  // pointing at the compose network's own hostnames, but the steps below run
  // `pnpm --filter @montaj/api db:migrate` etc. on the HOST, against the
  // stack's EXPOSED ports — so the clone still needs a `.env` for that, plus
  // the JWT keypair and callback secret every step downstream reads.
  writeCloneEnv(cloneDir);

  // --- 3. Compose up ---------------------------------------------------------
  // Uses the clone's own copy of the compose file (the fresh clone is what
  // is being verified) against the shared Docker daemon.
  runInClone("docker compose up", "node", [join(cloneDir, "scripts", "e2e-stack.mjs"), "up"]);

  // --- 4. Migrate + seed -----------------------------------------------------
  runInClone("db:migrate", "pnpm", ["--filter", "@montaj/api", "db:migrate"]);
  runInClone("db:seed", "pnpm", ["--filter", "@montaj/api", "db:seed"]);
  runInClone("db:seed:sample", "pnpm", ["--filter", "@montaj/api", "db:seed:sample"]);

  // --- 5. Unit tests -----------------------------------------------------
  runInClone("unit tests", "pnpm", ["-w", "test"]);

  // --- 6. e2e --------------------------------------------------------------
  runInClone("e2e", "pnpm", ["e2e"]);

  // --- 7. Parity gate --------------------------------------------------------
  runInClone("parity gate", "pnpm", ["parity"]);

  // --- 8. Collect screenshots -----------------------------------------------
  const date = new Date().toISOString().slice(0, 10);
  const reportDir = join(REPO_ROOT, "docs", "verification");
  const screenshotDir = join(reportDir, `${date}-wave${args.wave}-screenshots`);
  mkdirSync(screenshotDir, { recursive: true });
  const shotsStart = Date.now();
  let collected = 0;
  for (const candidate of [
    join(cloneDir, "apps", "web", "e2e", "__screenshots__"),
    join(cloneDir, "apps", "web", "test-results"),
  ]) {
    collected += copyPngsRecursively(candidate, screenshotDir);
  }
  results.push({
    name: "collect screenshots",
    status: collected > 0 ? "pass" : "skipped",
    durationMs: Date.now() - shotsStart,
    detail: `${collected} file(s) -> ${screenshotDir}`,
  });

  await writeSummary(overallStart, cloneDir, screenshotDir);

  if (!args.keepClone) rmSync(cloneDir, { recursive: true, force: true });

  const anyFailed = results.some((r) => r.status === "fail");
  process.exit(anyFailed ? 1 : 0);
}

function copyPngsRecursively(dir, destDir, depth = 0) {
  if (!existsSync(dir) || depth > 6) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += copyPngsRecursively(full, destDir, depth + 1);
    } else if (entry.isFile() && /\.png$/i.test(entry.name)) {
      const dest = join(destDir, `${Date.now()}-${entry.name}`);
      try {
        copyFileSync(full, dest);
        count += 1;
      } catch {
        // best-effort collection; a locked file is not a verification failure
      }
    }
  }
  return count;
}

async function writeSummary(overallStart, cloneDir, screenshotDir) {
  const date = new Date().toISOString().slice(0, 10);
  const reportDir = join(REPO_ROOT, "docs", "verification");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${date}-wave${args.wave}.md`);

  const rows = results
    .map(
      (r) =>
        `| ${r.name} | ${r.status.toUpperCase()} | ${fmtDuration(r.durationMs)} | ${r.detail || "-"} |`,
    )
    .join("\n");

  const overallStatus = results.some((r) => r.status === "fail") ? "FAIL" : "PASS";

  const body = `# Wave ${args.wave} verification — ${date}

Fresh-clone verification gate (\`docs/PLAN.md\`'s "Verification gate procedure"), run by \`scripts/verify-wave.mjs\`.

Clone directory: \`${cloneDir ?? "(clone failed before this point)"}\`
${screenshotDir === undefined ? "" : `Screenshots: \`${screenshotDir}\`\n`}
| Step | Status | Duration | Detail |
|---|---|---|---|
${rows}

**Overall: ${overallStatus}** (total ${fmtDuration(Date.now() - overallStart)})
`;
  writeFileSync(reportPath, body, "utf8");
  console.log(`[verify-wave] summary written to ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
