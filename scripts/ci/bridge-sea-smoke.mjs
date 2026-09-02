#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * CI smoke test for the C01 bridge SEA binary (`.github/workflows/ci.yml`,
 * `bridge-sea` job): launches the platform binary, waits for it to write the
 * discovery file (proof it bound a loopback port and generated a per-install
 * cert), then asks it to exit cleanly. No network calls — this only proves the
 * executable runs standalone with no `node_modules` beside it.
 */

const root = join(import.meta.dirname, "..", "..");
const binaryPath = join(
  root,
  "apps/bridge/dist",
  platform() === "win32" ? "aksharo-bridge.exe" : "aksharo-bridge",
);
const discoveryPath = join(homedir(), ".aksharo", "bridge.json");

if (!existsSync(binaryPath)) {
  console.error(`bridge SEA binary not found at ${binaryPath}`);
  process.exit(1);
}

// A clean slate: a leftover discovery file from a previous run would make this
// script "succeed" without the binary having written anything this time.
rmSync(join(homedir(), ".aksharo"), { recursive: true, force: true });

const child = spawn(binaryPath, [], { stdio: "inherit" });

const timeoutMs = 15_000;
const start = Date.now();

function fail(message) {
  console.error(`bridge-sea-smoke: ${message}`);
  child.kill();
  process.exit(1);
}

const poll = setInterval(() => {
  if (existsSync(discoveryPath)) {
    clearInterval(poll);
    let file;
    try {
      file = JSON.parse(readFileSync(discoveryPath, "utf8"));
    } catch (error) {
      fail(`discovery file is not valid JSON: ${String(error)}`);
      return;
    }
    if (
      typeof file.port !== "number" ||
      typeof file.certFingerprint !== "string" ||
      typeof file.bearer !== "string"
    ) {
      fail(`discovery file missing expected fields: ${JSON.stringify(file)}`);
      return;
    }
    console.log(`bridge-sea-smoke: discovery file OK (port ${file.port}, pid ${file.pid})`);
    child.kill(platform() === "win32" ? undefined : "SIGTERM");
    setTimeout(() => {
      rmSync(join(homedir(), ".aksharo"), { recursive: true, force: true });
      process.exit(0);
    }, 500);
    return;
  }
  if (Date.now() - start > timeoutMs) {
    clearInterval(poll);
    fail(`discovery file did not appear within ${timeoutMs}ms`);
  }
}, 200);

child.on("exit", (code) => {
  if (code !== null && code !== 0 && !existsSync(discoveryPath)) {
    clearInterval(poll);
    fail(`binary exited with code ${code} before writing the discovery file`);
  }
});
