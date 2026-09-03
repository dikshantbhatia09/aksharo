/**
 * Finds the local engine sidecar (`apps/engine`, C03a) from its discovery
 * file, so `LocalStore` can delegate transcription/alignment/render to it
 * (brief C04 §1). `apps/engine/src/discovery.ts` is that app's own,
 * app-private module — apps do not import each other's `src/` in this
 * monorepo — so this is a small, independent reader of the same on-disk
 * convention, validated with the shared `@montaj/engine-client` schema so
 * the wire shape cannot drift between the two.
 *
 * Returns `null` (never throws) when the engine is not running — tier D
 * (brief: "local engine disabled — cloud with a banner") or simply not
 * started yet; `LocalStore` surfaces that as `EngineUnavailableError`.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EngineClient, EngineDiscoveryFileSchema } from "@montaj/engine-client";

export function engineDiscoveryFilePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".aksharo", "engine.json");
}

export interface ConnectToLocalEngineDeps {
  readonly readFileFn?: (filePath: string, encoding: "utf8") => string;
  readonly homeDir?: string;
}

export function connectToLocalEngine(deps: ConnectToLocalEngineDeps = {}): EngineClient | null {
  const readFileFn = deps.readFileFn ?? readFileSync;
  try {
    const raw = readFileFn(engineDiscoveryFilePath(deps.homeDir), "utf8");
    const parsed = EngineDiscoveryFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return null;
    return new EngineClient({
      baseUrl: `http://127.0.0.1:${String(parsed.data.port)}`,
      bearer: parsed.data.bearer,
    });
  } catch {
    return null;
  }
}
