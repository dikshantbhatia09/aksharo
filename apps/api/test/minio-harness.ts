/**
 * Is an S3-compatible store reachable for the integration suite?
 *
 * Answered SYNCHRONOUSLY for the same reason `db-harness.ts` and `redis-harness.ts`
 * are: `describe.skipIf` is evaluated while the file is collected and this package
 * compiles to CommonJS, so there is no top-level await to hide an async probe
 * behind. The probe is a bare TCP connect in a child process — cheap,
 * cross-platform, and it needs no S3 client of its own.
 *
 * `MONTAJ_SKIP_STORAGE_TESTS=1` skips deliberately.
 */
import { spawnSync } from "node:child_process";

/** Why the suite was skipped, for the console message. */
export let storageSkipReason = "";

const PROBE = `
const net = require("node:net");
const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]) });
socket.setTimeout(2000);
socket.on("connect", () => { socket.destroy(); process.exit(0); });
socket.on("error", () => process.exit(1));
socket.on("timeout", () => process.exit(1));
`;

export function testStorageEndpoint(): string {
  return process.env["S3_ENDPOINT"] ?? "http://localhost:9000";
}

export function isStorageAvailable(): boolean {
  if (process.env["MONTAJ_SKIP_STORAGE_TESTS"] === "1") {
    storageSkipReason = "MONTAJ_SKIP_STORAGE_TESTS=1";
    return false;
  }

  let url: URL;
  try {
    url = new URL(testStorageEndpoint());
  } catch {
    storageSkipReason = `S3_ENDPOINT is not a URL: ${testStorageEndpoint()}`;
    return false;
  }

  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  const probe = spawnSync(process.execPath, ["-e", PROBE, url.hostname, port], {
    stdio: "pipe",
    timeout: 10_000,
  });
  if (probe.status === 0) return true;

  storageSkipReason = `no object store at ${url.host}`;
  return false;
}
