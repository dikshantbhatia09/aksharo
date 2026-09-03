/**
 * `LocalStore` — the desktop's local-mode data access (brief C04 §1): SQLite
 * for metadata, plain files for media, delegating transcription/alignment/
 * render to the engine sidecar over `@montaj/engine-client` (C03a) exactly
 * as the hosted editor would, so nothing about "how transcription happens"
 * forks between cloud and local.
 *
 * A plain class over an injected {@link LocalDb} and `EngineClient`, on the
 * same pattern `apps/web/lib/edg/store.ts`'s `EditorStore` uses: easy to
 * unit test with an in-memory database and a fake engine client, no
 * Electron runtime required (`store.test.ts`).
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { newId } from "@montaj/edg";
import type { EdgHot, Segment, TranscriptChunk } from "@montaj/edg/schemas";
import type {
  EngineClient,
  RenderRequest,
  TranscribeRequest,
  AlignRequest,
  ProbeResponse,
} from "@montaj/engine-client";

import type { LocalDb } from "./db.js";

export type MediaRole = "primary" | "broll" | "audio";

export interface LocalProject {
  readonly id: string;
  readonly title: string;
  readonly aspect: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalMedia {
  readonly id: string;
  readonly projectId: string;
  readonly role: MediaRole;
  readonly filePath: string;
  readonly durationMs: number | null;
  readonly fps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: string;
}

export interface LocalEdgSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly hot: EdgHot;
  readonly segments: Segment[];
  /**
   * Transcript chunks as of this snapshot (brief C04b §1): loaded from
   * `local_transcript_chunks`, not embedded in `local_edg_snapshots.doc` —
   * chunks are kept current (one row per `chunkIdx`), not versioned per
   * revision, so this is always "the chunks as they stand now", same as the
   * cloud path's `newestChunkRows` reads for the live document.
   */
  readonly chunks: TranscriptChunk[];
  readonly createdAt: string;
}

export type LocalExportStatus = "pending" | "done" | "failed";

export interface LocalExport {
  readonly id: string;
  readonly projectId: string;
  readonly outputPath: string;
  readonly status: LocalExportStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface LocalStoreDeps {
  readonly db: LocalDb;
  /** Directory imported media is copied into (`app.getPath("userData")/media`). */
  readonly mediaDir: string;
  /** The engine sidecar client (C03a); `null` when the engine is unavailable (tier D). */
  readonly engine: EngineClient | null;
  readonly newId?: () => string;
  readonly now?: () => Date;
  readonly copyFileFn?: typeof copyFile;
}

export class LocalProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`no local project ${projectId}`);
    this.name = "LocalProjectNotFoundError";
  }
}

export class EngineUnavailableError extends Error {
  constructor() {
    super("the local engine is unavailable");
    this.name = "EngineUnavailableError";
  }
}

type SqlValue = string | number | null;

/** Reads one row as a plain object, per `sql.js`'s `getAsObject()` shape. */
function rows(
  db: LocalDb,
  sql: string,
  params: Record<string, SqlValue> = {},
): Record<string, unknown>[] {
  const stmt = db.raw.prepare(sql);
  try {
    stmt.bind(params);
    const out: Record<string, unknown>[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function toProject(row: Record<string, unknown>): LocalProject {
  return {
    id: String(row["id"]),
    title: String(row["title"]),
    aspect: String(row["aspect"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toMedia(row: Record<string, unknown>): LocalMedia {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    role: row["role"] as MediaRole,
    filePath: String(row["file_path"]),
    durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
    fps: row["fps"] === null ? null : Number(row["fps"]),
    width: row["width"] === null ? null : Number(row["width"]),
    height: row["height"] === null ? null : Number(row["height"]),
    importedAt: String(row["imported_at"]),
  };
}

function toSnapshotDoc(row: Record<string, unknown>): { hot: EdgHot; segments: Segment[] } {
  return JSON.parse(String(row["doc"])) as { hot: EdgHot; segments: Segment[] };
}

function toChunkRow(row: Record<string, unknown>): TranscriptChunk {
  return {
    chunkIdx: Number(row["chunk_idx"]),
    startMs: Number(row["start_ms"]),
    endMs: Number(row["end_ms"]),
    words: JSON.parse(String(row["words"])) as TranscriptChunk["words"],
  };
}

function toExport(row: Record<string, unknown>): LocalExport {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    outputPath: String(row["output_path"]),
    status: row["status"] as LocalExportStatus,
    createdAt: String(row["created_at"]),
    completedAt: row["completed_at"] === null ? null : String(row["completed_at"]),
  };
}

export class LocalStore {
  private readonly db: LocalDb;
  private readonly mediaDir: string;
  private readonly engine: EngineClient | null;
  private readonly mintId: () => string;
  private readonly now: () => Date;
  private readonly copyFileFn: typeof copyFile;

  constructor(deps: LocalStoreDeps) {
    this.db = deps.db;
    this.mediaDir = deps.mediaDir;
    this.engine = deps.engine;
    this.mintId = deps.newId ?? newId;
    this.now = deps.now ?? (() => new Date());
    this.copyFileFn = deps.copyFileFn ?? copyFile;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  async createProject(input: { title: string; aspect: string }): Promise<LocalProject> {
    const id = this.mintId();
    const now = this.now().toISOString();
    this.db.raw.run(
      "INSERT INTO local_projects (id, title, aspect, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, input.title, input.aspect, now, now],
    );
    await this.db.persist();
    return { id, title: input.title, aspect: input.aspect, createdAt: now, updatedAt: now };
  }

  listProjects(): LocalProject[] {
    return rows(this.db, "SELECT * FROM local_projects ORDER BY updated_at DESC").map(toProject);
  }

  openProject(projectId: string): LocalProject {
    const row = rows(this.db, "SELECT * FROM local_projects WHERE id = $id", { $id: projectId })[0];
    if (row === undefined) throw new LocalProjectNotFoundError(projectId);
    return toProject(row);
  }

  private touchProject(projectId: string): void {
    this.db.raw.run("UPDATE local_projects SET updated_at = ? WHERE id = ?", [
      this.now().toISOString(),
      projectId,
    ]);
  }

  /** Deletes a project and everything under it: media rows, its files, snapshots and exports. */
  async deleteProject(projectId: string): Promise<void> {
    for (const media of this.listMedia(projectId)) {
      await rm(media.filePath, { force: true });
    }
    this.db.raw.run("DELETE FROM local_media WHERE project_id = ?", [projectId]);
    this.db.raw.run("DELETE FROM local_edg_snapshots WHERE project_id = ?", [projectId]);
    this.db.raw.run("DELETE FROM local_transcript_chunks WHERE project_id = ?", [projectId]);
    this.db.raw.run("DELETE FROM local_exports WHERE project_id = ?", [projectId]);
    this.db.raw.run("DELETE FROM local_projects WHERE id = ?", [projectId]);
    await this.db.persist();
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  listMedia(projectId: string): LocalMedia[] {
    return rows(
      this.db,
      "SELECT * FROM local_media WHERE project_id = $id ORDER BY imported_at ASC",
      { $id: projectId },
    ).map(toMedia);
  }

  /**
   * Imports a media file the user picked (`openMediaDialog`, C02) into the
   * project's media directory and records it.
   *
   * Duration/fps/width/height come from probing the file: the engine's
   * `/probe` (brief C04b §2, `EngineClient.probe`) when the caller does not
   * already supply the fields itself (a caller that already probed — or a
   * test — is not made to re-probe). Left `null` only when the engine is
   * unavailable (tier D) or the probe itself fails — a media import must
   * never fail just because probing did.
   */
  async importMedia(input: {
    projectId: string;
    sourcePath: string;
    role: MediaRole;
    probe?: { durationMs?: number; fps?: number; width?: number; height?: number };
  }): Promise<LocalMedia> {
    this.openProject(input.projectId); // throws LocalProjectNotFoundError if missing
    const id = this.mintId();
    const destDir = path.join(this.mediaDir, input.projectId);
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, `${id}${path.extname(input.sourcePath)}`);
    await this.copyFileFn(input.sourcePath, destPath);

    const probed = input.probe ?? (await this.probeMedia(destPath));
    input = { ...input, probe: probed };

    const importedAt = this.now().toISOString();
    this.db.raw.run(
      `INSERT INTO local_media
         (id, project_id, role, file_path, duration_ms, fps, width, height, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.role,
        destPath,
        input.probe?.durationMs ?? null,
        input.probe?.fps ?? null,
        input.probe?.width ?? null,
        input.probe?.height ?? null,
        importedAt,
      ],
    );
    this.touchProject(input.projectId);
    await this.db.persist();

    return {
      id,
      projectId: input.projectId,
      role: input.role,
      filePath: destPath,
      durationMs: input.probe?.durationMs ?? null,
      fps: input.probe?.fps ?? null,
      width: input.probe?.width ?? null,
      height: input.probe?.height ?? null,
      importedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Engine delegation (C03a's contract; no local-only branching)
  // -------------------------------------------------------------------------

  async transcribe(input: TranscribeRequest): ReturnType<EngineClient["transcribe"]> {
    if (this.engine === null) throw new EngineUnavailableError();
    return this.engine.transcribe(input);
  }

  async align(input: AlignRequest): ReturnType<EngineClient["align"]> {
    if (this.engine === null) throw new EngineUnavailableError();
    return this.engine.align(input);
  }

  /**
   * Probes a media file via the engine's `/probe` (brief C04b §2). Returns
   * all-`null` fields rather than throwing when the engine is unavailable or
   * the probe call itself fails — a media import must succeed either way,
   * only with less metadata.
   */
  private async probeMedia(filePath: string): Promise<{
    durationMs?: number;
    fps?: number;
    width?: number;
    height?: number;
  }> {
    if (this.engine === null) return {};
    try {
      const result: ProbeResponse = await this.engine.probe({ path: filePath });
      return {
        ...(result.durationMs === null ? {} : { durationMs: result.durationMs }),
        ...(result.fps === null ? {} : { fps: result.fps }),
        ...(result.width === null ? {} : { width: result.width }),
        ...(result.height === null ? {} : { height: result.height }),
      };
    } catch {
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // EDG snapshots + transcript chunks
  // -------------------------------------------------------------------------

  latestSnapshot(projectId: string): LocalEdgSnapshot | null {
    const row = rows(
      this.db,
      "SELECT * FROM local_edg_snapshots WHERE project_id = $id ORDER BY revision DESC LIMIT 1",
      { $id: projectId },
    )[0];
    if (row === undefined) return null;
    const doc = toSnapshotDoc(row);
    return {
      id: String(row["id"]),
      projectId: String(row["project_id"]),
      revision: Number(row["revision"]),
      hot: doc.hot,
      segments: doc.segments,
      chunks: this.transcriptChunks(projectId),
      createdAt: String(row["created_at"]),
    };
  }

  /** The project's transcript chunks, newest state per `chunkIdx` (brief C04b §1). */
  transcriptChunks(projectId: string): TranscriptChunk[] {
    return rows(
      this.db,
      "SELECT * FROM local_transcript_chunks WHERE project_id = $id ORDER BY chunk_idx ASC",
      { $id: projectId },
    ).map(toChunkRow);
  }

  /**
   * Upserts every chunk's current state (brief C04b §1): one row per
   * `chunkIdx`, kept current rather than versioned per revision — a local
   * project has exactly one writer, so there is nothing to rebase against a
   * prior chunk generation the way `EdgRepository.persistWords` guards for.
   */
  private saveTranscriptChunks(
    projectId: string,
    revision: number,
    chunks: readonly TranscriptChunk[],
  ): void {
    const now = this.now().toISOString();
    for (const chunk of chunks) {
      const existing = rows(
        this.db,
        "SELECT id FROM local_transcript_chunks WHERE project_id = $pid AND chunk_idx = $idx",
        { $pid: projectId, $idx: chunk.chunkIdx },
      )[0];
      const words = JSON.stringify(chunk.words);
      if (existing === undefined) {
        this.db.raw.run(
          `INSERT INTO local_transcript_chunks
             (id, project_id, revision, chunk_idx, start_ms, end_ms, words, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.mintId(),
            projectId,
            revision,
            chunk.chunkIdx,
            chunk.startMs,
            chunk.endMs,
            words,
            now,
          ],
        );
      } else {
        this.db.raw.run(
          `UPDATE local_transcript_chunks
             SET revision = ?, start_ms = ?, end_ms = ?, words = ?, updated_at = ?
           WHERE id = ?`,
          [revision, chunk.startMs, chunk.endMs, words, now, String(existing["id"])],
        );
      }
    }
  }

  /**
   * Saves the editor's current EDG v2 document as the next revision (brief
   * §1: "save EDG"). `chunks`, when given, replace the project's transcript
   * chunk rows with their current state (brief C04b §1) — omitted by a
   * caller that has not touched any word (a pure segment-level edit), which
   * leaves the existing chunks untouched rather than wiping them.
   */
  async saveEdgSnapshot(input: {
    projectId: string;
    hot: EdgHot;
    segments: Segment[];
    chunks?: readonly TranscriptChunk[];
  }): Promise<LocalEdgSnapshot> {
    this.openProject(input.projectId);
    const previous = this.latestSnapshot(input.projectId);
    const revision = (previous?.revision ?? 0) + 1;
    const id = this.mintId();
    const createdAt = this.now().toISOString();
    const doc = JSON.stringify({ hot: input.hot, segments: input.segments });

    this.db.raw.run(
      "INSERT INTO local_edg_snapshots (id, project_id, revision, doc, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, input.projectId, revision, doc, createdAt],
    );
    if (input.chunks !== undefined) {
      this.saveTranscriptChunks(input.projectId, revision, input.chunks);
    }
    this.touchProject(input.projectId);
    await this.db.persist();

    return {
      id,
      projectId: input.projectId,
      revision,
      hot: input.hot,
      segments: input.segments,
      chunks: this.transcriptChunks(input.projectId),
      createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  listExports(projectId: string): LocalExport[] {
    return rows(
      this.db,
      "SELECT * FROM local_exports WHERE project_id = $id ORDER BY created_at DESC",
      { $id: projectId },
    ).map(toExport);
  }

  /**
   * Renders the project's latest EDG snapshot to `outputPath` via the
   * engine's `/render` (delegates to `@montaj/render-skia-node`, brief §1) —
   * `drawCommandsPath` is the caller's (the renderer's export pipeline
   * already knows how to turn an `EdgHot`/segment set into draw commands;
   * that pipeline is `apps/web/lib/export/engine.ts`'s, out of this store's
   * scope). Falls back to `pending`/`failed` rather than throwing so a
   * failed local render is a recorded row a user can retry, not a lost one.
   */
  async runExport(input: RenderRequest & { projectId: string }): Promise<LocalExport> {
    const id = this.mintId();
    const createdAt = this.now().toISOString();
    this.db.raw.run(
      "INSERT INTO local_exports (id, project_id, output_path, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL)",
      [id, input.projectId, input.outputPath, "pending", createdAt],
    );
    await this.db.persist();

    if (this.engine === null) {
      this.db.raw.run("UPDATE local_exports SET status = 'failed' WHERE id = ?", [id]);
      await this.db.persist();
      throw new EngineUnavailableError();
    }

    try {
      await this.engine.render({
        drawCommandsPath: input.drawCommandsPath,
        width: input.width,
        height: input.height,
        fps: input.fps,
        outputPath: input.outputPath,
      });
      const completedAt = this.now().toISOString();
      this.db.raw.run("UPDATE local_exports SET status = 'done', completed_at = ? WHERE id = ?", [
        completedAt,
        id,
      ]);
      await this.db.persist();
      return {
        id,
        projectId: input.projectId,
        outputPath: input.outputPath,
        status: "done",
        createdAt,
        completedAt,
      };
    } catch (error) {
      this.db.raw.run("UPDATE local_exports SET status = 'failed' WHERE id = ?", [id]);
      await this.db.persist();
      throw error;
    }
  }
}
