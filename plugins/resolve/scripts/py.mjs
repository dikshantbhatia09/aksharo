#!/usr/bin/env node
/**
 * Cross-platform bridge from pnpm/turbo to this plugin's Python virtual
 * environment (mirrors `apps/worker-ai/scripts/py.mjs`).
 *
 *   node scripts/py.mjs -m pytest -q
 *   node scripts/py.mjs --setup-only
 *
 * The venv lives at `plugins/resolve/.venv` and is created on first use.
 * Reinstalls happen only when `requirements-dev.lock` changes, tracked by a
 * hash stamp inside the venv. Override the base interpreter with
 * `PYTHON=/path/to/python3.12`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_DIR = join(APP_DIR, ".venv");
const IS_WINDOWS = process.platform === "win32";
const VENV_PYTHON = IS_WINDOWS
  ? join(VENV_DIR, "Scripts", "python.exe")
  : join(VENV_DIR, "bin", "python");
const LOCK_FILE = join(APP_DIR, "requirements-dev.lock");
const STAMP_FILE = join(VENV_DIR, ".montaj-lock-hash");

/** @param {string} message */
function note(message) {
  process.stderr.write(`[resolve] ${message}\n`);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {number}
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: APP_DIR, stdio: "inherit" });
  if (result.error) {
    note(`failed to run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** Base interpreter used to create the venv. */
function basePython() {
  const override = process.env["PYTHON"];
  if (override !== undefined && override !== "") return override;
  return IS_WINDOWS ? "python" : "python3";
}

function lockHash() {
  if (!existsSync(LOCK_FILE)) return "no-lock";
  return createHash("sha256").update(readFileSync(LOCK_FILE)).digest("hex");
}

function stampMatches() {
  if (!existsSync(STAMP_FILE)) return false;
  return readFileSync(STAMP_FILE, "utf8").trim() === lockHash();
}

/** Create the venv and install pinned dependencies when anything is stale. */
function ensureVenv() {
  if (!existsSync(VENV_PYTHON)) {
    note(`creating .venv with ${basePython()} (first run only)`);
    const created = run(basePython(), ["-m", "venv", VENV_DIR]);
    if (created !== 0) {
      note("could not create the virtual environment.");
      note("Install Python 3.12 and retry, or set PYTHON=/path/to/python3.12.");
      return created;
    }
  }

  if (stampMatches()) return 0;

  note("installing pinned Python dependencies (requirements-dev.lock)");
  const upgraded = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  if (upgraded !== 0) return upgraded;

  if (existsSync(LOCK_FILE)) {
    const installed = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "-r", LOCK_FILE]);
    if (installed !== 0) return installed;
  } else {
    note("requirements-dev.lock is missing; falling back to pyproject extras");
    const installed = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "-e", ".[dev]"]);
    if (installed !== 0) return installed;
  }

  // Editable install so `aksharo_core_app` is importable without touching PYTHONPATH.
  const linked = run(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "--no-deps", "-e", "."]);
  if (linked !== 0) return linked;

  writeFileSync(STAMP_FILE, lockHash(), "utf8");
  return 0;
}

const args = process.argv.slice(2);
const setupOnly = args[0] === "--setup-only";

const prepared = ensureVenv();
if (prepared !== 0) process.exit(prepared);

if (setupOnly) {
  note(`ready: ${VENV_PYTHON}`);
  process.exit(0);
}

process.exit(run(VENV_PYTHON, args));
