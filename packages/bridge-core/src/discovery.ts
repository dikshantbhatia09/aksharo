import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * The discovery file (`~/.aksharo/bridge.json`, brief §2): how a loopback client
 * (desktop shell, UXP/CEP panel) finds a running bridge without a fixed port.
 * Written with mode `0600` (owner read/write only) because it carries the bearer
 * token that authorises every route.
 */

export const DiscoveryFileSchema = z.object({
  port: z.number().int().positive(),
  certFingerprint: z.string().min(1),
  bearer: z.string().min(32),
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.string(),
});
export type DiscoveryFile = z.infer<typeof DiscoveryFileSchema>;

export function aksharoDir(): string {
  return join(homedir(), ".aksharo");
}

export function discoveryFilePath(): string {
  return join(aksharoDir(), "bridge.json");
}

/** A fresh, high-entropy bearer token: 256 bits, base64url. */
export function generateBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Writes the discovery file atomically with `0600` permissions. */
export function writeDiscoveryFile(file: DiscoveryFile, path = discoveryFilePath()): void {
  const dir = aksharoDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  // Rename is atomic on POSIX; on Windows it replaces the destination as of
  // Node 22's `fs.renameSync`, which is what we need — no client ever observes
  // a half-written file.
  renameOverwrite(tmp, path);
}

function renameOverwrite(from: string, to: string): void {
  try {
    // node:fs renameSync overwrites `to` on both POSIX and Windows.
    renameSync(from, to);
  } catch {
    // Fallback for filesystems that refuse cross-device or locked renames:
    // copy then remove the temp file.
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    unlinkSync(from);
  }
}

export function readDiscoveryFile(path = discoveryFilePath()): DiscoveryFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = DiscoveryFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
