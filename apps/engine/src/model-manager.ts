import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ModelState, ModelStatus } from "@montaj/engine-client";

import type { EngineManifest, ManifestEntry } from "./manifest.js";

/**
 * The model manager (brief §3): manifest-driven downloads with SHA-256
 * verification, resumable via HTTP `Range`, a disk budget, delete, and a
 * hash re-check of every installed file on launch (THREAT-MODEL T22: "hash
 * check on launch"). No binary or weight file is ever bundled with the repo
 * — everything comes from `MODEL_WEIGHTS_BASE_URL` (brief "Reality").
 *
 * `fetchImpl` is injectable so tests exercise checksum failure, resume and
 * budget behaviour against an in-memory fake server rather than a real
 * `MODEL_WEIGHTS_BASE_URL` (never reachable, and never should be, from this
 * sandbox per the host guard).
 */

export class ModelManagerError extends Error {
  constructor(
    message: string,
    readonly code: "checksum_mismatch" | "disk_budget_exceeded" | "download_failed" | "not_found",
  ) {
    super(message);
    this.name = "ModelManagerError";
  }
}

export interface ModelManagerOptions {
  readonly manifest: EngineManifest;
  readonly baseUrl: string;
  readonly modelsDir: string;
  readonly diskBudgetBytes: number;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (entryId: string, progress: number) => void;
}

interface DownloadState {
  state: ModelState;
  progress?: number;
}

export class ModelManager {
  private readonly manifest: EngineManifest;
  private readonly baseUrl: string;
  private readonly modelsDir: string;
  private readonly diskBudgetBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onProgress: (entryId: string, progress: number) => void;
  private readonly downloadStates = new Map<string, DownloadState>();

  constructor(options: ModelManagerOptions) {
    this.manifest = options.manifest;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.modelsDir = options.modelsDir;
    this.diskBudgetBytes = options.diskBudgetBytes;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onProgress = options.onProgress ?? (() => undefined);
  }

  diskBudgetBytesPublic(): number {
    return this.diskBudgetBytes;
  }

  defaultModelId(): string {
    return this.manifest.defaultAsrModel;
  }

  fallbackModelId(): string {
    return this.manifest.fallbackAsrModel;
  }

  entry(id: string): ManifestEntry {
    const entry = this.manifest.entries.find((e) => e.id === id);
    if (entry === undefined) throw new ModelManagerError(`unknown model id "${id}"`, "not_found");
    return entry;
  }

  localPath(entryId: string): string {
    return join(this.modelsDir, this.entry(entryId).path);
  }

  /** Statuses for every manifest entry, `installed` when its file exists on disk with the right size. */
  async listStatuses(): Promise<ModelStatus[]> {
    const statuses: ModelStatus[] = [];
    for (const entry of this.manifest.entries) {
      const path = this.localPath(entry.id);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const stats = await stat(path).catch(() => undefined);
      const downloadState = this.downloadStates.get(entry.id);
      let state: ModelState;
      if (downloadState !== undefined) {
        state = downloadState.state;
      } else if (stats !== undefined && stats.size === entry.sizeBytes) {
        state = "installed";
      } else {
        state = "available";
      }
      statuses.push({
        id: entry.id,
        kind: entry.kind === "asr-coreml" ? "asr-coreml" : (entry.kind as ModelStatus["kind"]),
        sizeBytes: entry.sizeBytes,
        state,
        ...(downloadState?.progress === undefined ? {} : { progress: downloadState.progress }),
        sha256: entry.sha256,
        version: entry.version,
      });
    }
    return statuses;
  }

  async diskUsageBytes(): Promise<number> {
    let total = 0;
    for (const entry of this.manifest.entries) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const stats = await stat(this.localPath(entry.id)).catch(() => undefined);
      if (stats !== undefined) total += stats.size;
    }
    return total;
  }

  /** True when nothing at all is installed — the engine's "models missing" state (brief "Reality"). */
  async modelsMissing(): Promise<boolean> {
    for (const entry of this.manifest.entries) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const stats = await stat(this.localPath(entry.id)).catch(() => undefined);
      if (stats !== undefined && stats.size === entry.sizeBytes) return false;
    }
    return true;
  }

  /**
   * Downloads one entry to `modelsDir`, resuming a partial `.part` file via
   * `Range: bytes=<offset>-`, then verifies its SHA-256 before the atomic
   * rename into place. A checksum failure deletes the bad file and throws
   * rather than leaving a corrupt model the engine might load.
   */
  async download(entryId: string): Promise<void> {
    const entry = this.entry(entryId);
    const finalPath = this.localPath(entryId);
    const partPath = `${finalPath}.part`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    await mkdir(dirname(finalPath), { recursive: true });

    this.downloadStates.set(entryId, { state: "downloading", progress: 0 });
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const existing = await stat(partPath).catch(() => undefined);
      const resumeFrom = existing?.size ?? 0;

      const projectedTotal = (await this.diskUsageBytes()) + entry.sizeBytes - resumeFrom;
      if (projectedTotal > this.diskBudgetBytes) {
        throw new ModelManagerError(
          `downloading "${entryId}" (${String(entry.sizeBytes)} bytes) would exceed the disk budget`,
          "disk_budget_exceeded",
        );
      }

      const url = `${this.baseUrl}/${entry.path}`;
      const response = await this.fetchImpl(url, {
        headers: resumeFrom > 0 ? { range: `bytes=${String(resumeFrom)}-` } : {},
      });
      if (!response.ok || response.body === null) {
        throw new ModelManagerError(
          `download of "${entryId}" failed: HTTP ${String(response.status)}`,
          "download_failed",
        );
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const handle = await open(partPath, resumeFrom > 0 && response.status === 206 ? "r+" : "w");
      try {
        if (resumeFrom > 0 && response.status === 206) await handle.truncate(resumeFrom);
        let written = resumeFrom;
        const reader = response.body as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of reader) {
          await handle.write(chunk, 0, chunk.length, written);
          written += chunk.length;
          const progress = entry.sizeBytes > 0 ? Math.min(1, written / entry.sizeBytes) : 1;
          this.downloadStates.set(entryId, { state: "downloading", progress });
          this.onProgress(entryId, progress);
        }
      } finally {
        await handle.close();
      }

      const digest = await sha256File(partPath);
      if (digest !== entry.sha256) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
        await unlink(partPath).catch(() => undefined);
        this.downloadStates.set(entryId, { state: "failed" });
        throw new ModelManagerError(
          `checksum mismatch for "${entryId}": expected ${entry.sha256}, got ${digest}`,
          "checksum_mismatch",
        );
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      await rename(partPath, finalPath);
      this.downloadStates.delete(entryId);
    } catch (error) {
      if (this.downloadStates.get(entryId)?.state !== "failed") {
        this.downloadStates.set(entryId, { state: "failed" });
      }
      throw error;
    }
  }

  async delete(entryId: string): Promise<void> {
    const path = this.localPath(entryId);
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
    this.downloadStates.delete(entryId);
  }

  /**
   * Re-verifies every installed file's SHA-256 on launch (THREAT-MODEL T22).
   * Returns the ids that failed verification (wrong hash, or a size mismatch
   * treated as "not installed" rather than a failure) so the caller can mark
   * them for re-download rather than ever running a tampered binary.
   */
  async verifyAll(): Promise<{ verified: string[]; failed: string[] }> {
    const verified: string[] = [];
    const failed: string[] = [];
    for (const entry of this.manifest.entries) {
      const path = this.localPath(entry.id);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
      const stats = await stat(path).catch(() => undefined);
      if (stats === undefined) continue;
      if (stats.size !== entry.sizeBytes) {
        failed.push(entry.id);
        continue;
      }
      const digest = await sha256File(path);
      if (digest === entry.sha256) {
        verified.push(entry.id);
      } else {
        failed.push(entry.id);
      }
    }
    return { verified, failed };
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const handle = await open(path, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Uint8Array);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
