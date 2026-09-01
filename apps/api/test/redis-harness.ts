/**
 * Is a Redis reachable for the integration suite?
 *
 * Answered SYNCHRONOUSLY for the same reason `db-harness.ts` is: `describe.skipIf`
 * is evaluated while the file is collected, and this package compiles to CommonJS,
 * so there is no top-level await to hide an async probe behind. The probe is a
 * bare TCP connect in a child process — cheap, cross-platform, and it needs no
 * Redis client of its own.
 *
 * `MONTAJ_SKIP_REDIS_TESTS=1` skips deliberately.
 */
import { spawnSync } from "node:child_process";

/** Why the suite was skipped, for the console message. */
export let redisSkipReason = "";

const PROBE = `
const net = require("node:net");
const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
socket.setTimeout(2000);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.on("timeout", () => process.exit(1));
`;

export function testRedisUrl(): string {
  return process.env["TEST_REDIS_URL"] ?? process.env["REDIS_URL"] ?? "redis://localhost:6379";
}

export function isRedisAvailable(): boolean {
  if (process.env["MONTAJ_SKIP_REDIS_TESTS"] === "1") {
    redisSkipReason = "MONTAJ_SKIP_REDIS_TESTS=1";
    return false;
  }

  let url: URL;
  try {
    url = new URL(testRedisUrl());
  } catch {
    redisSkipReason = `REDIS_URL is not a URL: ${testRedisUrl()}`;
    return false;
  }

  const probe = spawnSync(
    process.execPath,
    ["-e", PROBE, url.hostname, url.port === "" ? "6379" : url.port],
    { stdio: "pipe", timeout: 10_000 },
  );
  if (probe.status === 0) return true;

  redisSkipReason = `redis is not reachable at ${url.host}`;
  return false;
}
