import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { type $Enums } from "@prisma/client";

import { newId } from "@montaj/edg";
import {
  type Aspect,
  type EdgHot,
  type EdgOp,
  type EdgSource,
  type OpBatchResponse,
  type Pass,
  type PassItem,
  type ScriptId,
  type Segment,
  type Speaker,
  type TranscriptChunk,
  type Word,
} from "@montaj/edg/schemas";
import { type SegmenterParams, segmentWords } from "@montaj/edg/segmenter";

import {
  EDG_ERROR_CODES,
  MAX_OPS_SINCE_REVISIONS,
  REVISION_PAGE_SIZE,
  SEGMENT_PAGE_SIZE,
} from "./edg.errors.js";
import { EdgRateLimiter } from "./edg.rate-limit.js";
import {
  type CommitOutcome,
  EdgNotFoundError,
  EdgRepository,
  RestoreInvalidError,
  SnapshotNotFoundError,
} from "./edg.repository.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

/**
 * The EDG feature module's service: authorisation, the HTTP-shaped reads, and
 * the one write path every surface funnels into.
 *
 * It owns three things the repository deliberately does not:
 *
 * * **Tenancy.** Every entry point starts from `(projectId, workspaceId)` and a
 *   project in another workspace is a 404, never a 403 — an id must not be
 *   testable for existence (THREAT-MODEL T5).
 * * **The write budget.** `rate-limited` is the one rejection reason the engine
 *   never produces (`packages/edg/README.md`); it is raised here.
 * * **The realtime echo.** `edg.ops` is published after the transaction commits,
 *   so no client can be told about a revision the database would still roll back.
 */

/** What A11 hands `initialise` once the segmenter has run. */
export interface EdgInitInput {
  readonly transcriptId: string;
  /** BCP-47 tag; Hinglish is `hi-Latn`. */
  readonly language: string;
  readonly scripts: readonly ScriptId[];
  readonly speakers?: readonly Speaker[];
  /** The transcript as `transcript_chunks` holds it. */
  readonly chunks: readonly TranscriptChunk[];
  /** Segmenter limits; the defaults of `09 §3` apply to anything omitted. */
  readonly segmenter?: Partial<SegmenterParams>;
  readonly dropFillers?: boolean;
  /** Style every initial segment carries. */
  readonly styleRef?: string;
  /**
   * What produced this document, for `EdgHot.meta.engineVersions` (CONTRACTS §2).
   *
   * A11 records the caption budgets it segmented with here (decision D78), so A15
   * can offer "Reflow captions" when the style changes and know what the old
   * budget was. Free-form by contract: `Record<string, string>`.
   */
  readonly engineVersions?: Record<string, string>;
  readonly author?: string | null;
  readonly source?: EdgSource;
}

export interface EdgInitResult {
  readonly edgId: string;
  readonly revision: number;
  readonly segments: number;
  /** `false` when the project already had a document and nothing was written. */
  readonly created: boolean;
}

export interface OpBatchInput {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userId: string | null;
  readonly baseRevision: number;
  readonly ops: readonly EdgOp[];
  readonly clientOpIds: readonly string[];
  readonly source: EdgSource;
  /** Skip the workspace budget — the signed worker surface has its own admission control. */
  readonly skipRateLimit?: boolean;
}

/** `GET /projects/{id}/edg`: the hot document, its revision and the first page. */
export interface EdgDocumentView {
  readonly revision: number;
  readonly schemaVersion: number;
  readonly hot: EdgHot;
  readonly segments: Segment[];
  readonly nextCursor: string | null;
  readonly passes: Pass[];
  readonly updatedAt: string;
}

/** Canvas sizes per aspect: the render resolutions of `05 §4`. */
const CANVAS_SIZES: Record<Aspect, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

const ASPECTS: Record<$Enums.Aspect, Aspect> = {
  r9x16: "9:16",
  r16x9: "16:9",
  r1x1: "1:1",
  r4x5: "4:5",
};

/** Media roles the EDG references; `font` and `image` are assets, not timeline media. */
const MEDIA_ROLES = new Set<$Enums.MediaRole>(["primary", "broll", "audio"]);

@Injectable()
export class EdgService {
  private readonly logger = new Logger(EdgService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: EdgRepository,
    private readonly limiter: EdgRateLimiter,
    private readonly realtime: RealtimePublisher,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async document(projectId: string, workspaceId: string): Promise<EdgDocumentView> {
    const edg = await this.resolve(projectId, workspaceId);
    const [{ hot, revision }, page, passes] = await Promise.all([
      this.repository.loadHot(edg.id),
      this.repository.loadSegments(edg.id, undefined, SEGMENT_PAGE_SIZE),
      this.repository.loadPasses(edg.id),
    ]);

    return {
      revision,
      schemaVersion: hot.meta.schemaVersion,
      hot,
      segments: page.segments,
      nextCursor: page.cursor ?? null,
      passes,
      updatedAt: edg.updatedAt.toISOString(),
    };
  }

  async segments(
    projectId: string,
    workspaceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ segments: Segment[]; nextCursor: string | null; revision: number }> {
    const edg = await this.resolve(projectId, workspaceId);
    const page = await this.repository.loadSegments(edg.id, cursor, limit);
    return { segments: page.segments, nextCursor: page.cursor ?? null, revision: edg.revision };
  }

  async passes(projectId: string, workspaceId: string): Promise<Pass[]> {
    const edg = await this.resolve(projectId, workspaceId);
    return this.repository.loadPasses(edg.id);
  }

  async items(
    projectId: string,
    workspaceId: string,
    passId: string,
    state?: $Enums.ItemState,
  ): Promise<PassItem[]> {
    const edg = await this.resolve(projectId, workspaceId);
    const pass = await this.prisma.edgPass.findFirst({
      where: { id: passId, edgId: edg.id },
      select: { id: true },
    });
    // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
    if (pass === null) {
      throw new AppException(
        EDG_ERROR_CODES.passNotFound,
        "No such pass on this project.",
        HttpStatus.NOT_FOUND,
      );
    }
    const items = await this.repository.loadItems(passId);
    return state === undefined ? items : items.filter((item) => item.state === state);
  }

  async revisions(
    projectId: string,
    workspaceId: string,
    from: number,
    limit = REVISION_PAGE_SIZE,
  ): Promise<{
    revisions: {
      revision: number;
      ops: EdgOp[];
      clientOpIds: string[];
      author: string | null;
      source: EdgSource;
      at: string;
    }[];
    latestRevision: number;
    nextFrom: number | null;
  }> {
    const edg = await this.resolve(projectId, workspaceId);
    const rows = await this.repository.loadRevisions(edg.id, from, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      revisions: page.map((row) => ({ ...row, at: row.at.toISOString() })),
      latestRevision: edg.revision,
      nextFrom: rows.length > limit && last !== undefined ? last.revision + 1 : null,
    };
  }

  async snapshots(
    projectId: string,
    workspaceId: string,
  ): Promise<{ revision: number; createdAt: string }[]> {
    const edg = await this.resolve(projectId, workspaceId);
    const rows = await this.repository.listSnapshots(edg.id);
    return rows.map((row) => ({ revision: row.revision, createdAt: row.createdAt.toISOString() }));
  }

  // -------------------------------------------------------------------------
  // The write path
  // -------------------------------------------------------------------------

  /**
   * `POST /projects/{id}/edg/ops` — the one write path.
   *
   * A client that is behind is **rebased server-side** and its batch applied;
   * that is what `OpBatchResponse.rebased` reports and what makes the editor
   * usable on a flaky connection. Two cases are the client's to resolve and come
   * back as a 409 instead:
   *
   * * a `conflict` from the rebase — two writers typed different text into the
   *   same caption or corrected the same word — carrying `opsSince` (which holds
   *   the winner's text) and an explicit `conflicts` list with both strings;
   * * more than {@link MAX_OPS_SINCE_REVISIONS} revisions behind, or a state
   *   replacement in between: `edg/too_stale`, meaning reload.
   */
  async applyOps(input: OpBatchInput): Promise<OpBatchResponse> {
    const edg = await this.resolve(input.projectId, input.workspaceId);

    if (input.skipRateLimit !== true) {
      const verdict = await this.limiter.consume(input.workspaceId);
      if (!verdict.allowed) {
        throw new AppException(
          ERROR_CODES.rateLimited,
          "This workspace is sending op batches faster than the editor allows.",
          HttpStatus.TOO_MANY_REQUESTS,
          {
            bucket: "edg:ops",
            retryAfterSec: verdict.retryAfterSec,
            // The closed enum of `packages/edg` has a reason for exactly this,
            // and it is the API — never the engine — that raises it.
            rejected: input.ops.map((op) => ({ opId: op.opId, reason: "rate-limited" as const })),
          },
        );
      }
    }

    const outcome = await this.commit({
      edgId: edg.id,
      baseRevision: input.baseRevision,
      ops: input.ops,
      clientOpIds: input.clientOpIds,
      author: input.userId,
      source: input.source,
    });

    return this.respond(input.projectId, input.source, outcome);
  }

  /**
   * The signed worker path: ops submitted as `source: "worker"`.
   *
   * The HMAC is the authorisation, so there is no membership to check and no
   * workspace to derive one from — the project's own workspace is looked up for
   * the realtime room and nothing else. The workspace op budget is deliberately
   * not charged: a finished pass has already been admitted by A08 and dropping it
   * here would throw away work the user has paid for.
   */
  async applyWorkerOps(input: {
    projectId: string;
    baseRevision: number;
    ops: readonly EdgOp[];
    clientOpIds: readonly string[];
  }): Promise<OpBatchResponse> {
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, deletedAt: null },
      select: { workspaceId: true },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }

    return this.applyOps({
      projectId: input.projectId,
      workspaceId: project.workspaceId,
      userId: null,
      baseRevision: input.baseRevision,
      ops: input.ops,
      clientOpIds: input.clientOpIds,
      source: "worker",
      skipRateLimit: true,
    });
  }

  /**
   * `POST /projects/{id}/edg/resegment` — re-run segmentation with new limits.
   *
   * The server mints the `Resegment` op rather than trusting the client to,
   * because the op is the audited record of what happened and its `opId` has to
   * be one this API can vouch for. Everything after that is the ordinary write
   * path, so a resegment rebases, conflicts and snapshots like any other batch.
   */
  async resegment(input: {
    projectId: string;
    workspaceId: string;
    userId: string;
    params: { maxChars: number; maxLines: number; minMs: number; maxMs: number };
    dropFillers?: boolean;
    source: EdgSource;
  }): Promise<OpBatchResponse> {
    const edg = await this.resolve(input.projectId, input.workspaceId);
    const op: EdgOp = { opId: newId(), type: "Resegment", ...input.params };

    const outcome = await this.commit({
      edgId: edg.id,
      baseRevision: edg.revision,
      ops: [op],
      clientOpIds: [op.opId],
      author: input.userId,
      source: input.source,
      ...(input.dropFillers === undefined ? {} : { dropFillers: input.dropFillers }),
    });

    return this.respond(input.projectId, input.source, outcome);
  }

  /**
   * `POST /projects/{id}/edg/snapshots/{n}/restore`.
   *
   * Appends a revision that replaces the state; the op log keeps everything that
   * happened in between, so "restore" is itself undoable by restoring a later
   * snapshot. The new revision carries no ops, which tells a client rebasing
   * across it to reload rather than replay.
   *
   * The transcript is **not** rolled back, so a snapshot can outlive the words it
   * names. One that does is refused with `edg/restore_invalid` and the list of
   * dangling word ids, rather than written as a caption nothing can render.
   */
  async restore(input: {
    projectId: string;
    workspaceId: string;
    userId: string;
    snapshotRevision: number;
    source: EdgSource;
  }): Promise<{ revision: number; segments: number }> {
    const edg = await this.resolve(input.projectId, input.workspaceId);
    try {
      const result = await this.repository.restoreSnapshot({
        edgId: edg.id,
        snapshotRevision: input.snapshotRevision,
        author: input.userId,
        source: input.source,
      });
      await this.publish(input.projectId, result.revision, [], input.source);
      return result;
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * Create the document from segmenter output — the entry point A11 calls once a
   * transcript is ready.
   *
   * Idempotent by project: a re-run after a retried transcription returns the
   * existing document instead of a second one, because `edg_documents.project_id`
   * is unique and re-segmenting a live document is a `Resegment` op, not a
   * creation.
   */
  async initialise(projectId: string, transcript: EdgInitInput): Promise<EdgInitResult> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: {
        id: true,
        aspect: true,
        edgDocument: { select: { id: true, revision: true } },
        mediaAssets: {
          where: { role: { in: ["primary", "broll", "audio"] } },
          select: { id: true, role: true, durationMs: true, fps: true, width: true, height: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }

    if (project.edgDocument !== null) {
      const segments = await this.prisma.edgSegment.count({
        where: { edgId: project.edgDocument.id, deletedAtRev: null },
      });
      return {
        edgId: project.edgDocument.id,
        revision: project.edgDocument.revision,
        segments,
        created: false,
      };
    }

    const edgId = newId();
    const words: Word[] = transcript.chunks.flatMap((chunk) => chunk.words);
    const segments = segmentWords(words, transcript.segmenter ?? {}, {
      newId,
      dropFillers: transcript.dropFillers === true,
      ...(transcript.styleRef === undefined ? {} : { styleRef: transcript.styleRef }),
    });

    const aspect = ASPECTS[project.aspect];
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const canvas = CANVAS_SIZES[aspect];
    const hot: EdgHot = {
      meta: {
        edgId,
        projectId,
        revision: 0,
        schemaVersion: 2,
        ...(transcript.engineVersions === undefined
          ? {}
          : { engineVersions: transcript.engineVersions }),
      },
      media: project.mediaAssets
        .filter((asset) => MEDIA_ROLES.has(asset.role))
        .map((asset) => ({
          mediaId: asset.id,
          role: asset.role as "primary" | "broll" | "audio",
          durationMs: asset.durationMs ?? 0,
          ...(asset.fps === null ? {} : { fps: asset.fps }),
          ...(asset.width === null ? {} : { width: asset.width }),
          ...(asset.height === null ? {} : { height: asset.height }),
        })),
      transcript: {
        transcriptId: transcript.transcriptId,
        revision: 1,
        language: transcript.language,
        scripts: [...transcript.scripts],
        ...(transcript.speakers === undefined ? {} : { speakers: [...transcript.speakers] }),
      },
      canvas: { aspect, width: canvas.width, height: canvas.height },
      styles: { defaultStyleId: transcript.styleRef ?? "clean-bold" },
    };

    const created = await this.repository.createDocument({
      edgId,
      projectId,
      hot,
      segments,
      author: transcript.author ?? null,
      source: transcript.source ?? "worker",
    });

    this.logger.log(
      { projectId, edgId, segments: created.segments },
      "edg document created from segmenter output",
    );
    return { ...created, created: true };
  }

  /**
   * `POST /projects/{id}/edg/import` (brief C04 §3): writes a whole,
   * already-edited EDG v2 document as revision 1 of a fresh project — the
   * desktop's "Upload to cloud" creates a *new* cloud project from a local
   * one and hands over its document verbatim, rather than replaying ops or
   * re-running the segmenter (that is what `initialise` is for). A project
   * that already has a document refuses with `edg/already_imported`: import
   * only ever creates the first one, exactly like `initialise`, and this
   * WP's scope explicitly excludes a local-to-cloud merge.
   */
  async importSnapshot(input: {
    projectId: string;
    workspaceId: string;
    hot: EdgHot;
    segments: readonly Segment[];
    author?: string | null;
    source?: EdgSource;
  }): Promise<{ edgId: string; revision: number; segments: number }> {
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true, edgDocument: { select: { id: true } } },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    if (project.edgDocument !== null) {
      throw new AppException(
        EDG_ERROR_CODES.alreadyImported,
        "This project already has a document.",
        HttpStatus.CONFLICT,
      );
    }

    const edgId = newId();
    const hot: EdgHot = {
      ...input.hot,
      meta: { ...input.hot.meta, edgId, projectId: input.projectId },
    };

    const created = await this.repository.createDocument({
      edgId,
      projectId: input.projectId,
      hot,
      segments: input.segments,
      author: input.author ?? null,
      source: input.source ?? "desktop",
    });

    this.logger.log(
      { projectId: input.projectId, edgId, segments: created.segments },
      "edg document imported from a local project (upload to cloud)",
    );
    return created;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The document row for a project the caller's workspace owns, or a 404. */
  private async resolve(
    projectId: string,
    workspaceId: string,
  ): Promise<{ id: string; revision: number; updatedAt: Date }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      select: { edgDocument: { select: { id: true, revision: true, updatedAt: true } } },
    });
    if (project === null) {
      // Not a 403: a project id in another workspace must be indistinguishable
      // from one that does not exist (THREAT-MODEL T5).
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    if (project.edgDocument === null) {
      throw new AppException(
        EDG_ERROR_CODES.notInitialised,
        "This project has no editing document yet.",
        HttpStatus.NOT_FOUND,
      );
    }
    return project.edgDocument;
  }

  private async commit(input: {
    edgId: string;
    baseRevision: number;
    ops: readonly EdgOp[];
    clientOpIds: readonly string[];
    author: string | null;
    source: EdgSource;
    dropFillers?: boolean;
  }): Promise<CommitOutcome> {
    try {
      return await this.repository.commit(input);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Turn a commit outcome into the CONTRACTS §2 response, or the 409 it deserves. */
  private async respond(
    projectId: string,
    source: EdgSource,
    outcome: CommitOutcome,
  ): Promise<OpBatchResponse> {
    switch (outcome.kind) {
      case "applied":
        await this.publish(projectId, outcome.revision, outcome.ops, source);
        return {
          revision: outcome.revision,
          applied: outcome.applied,
          rebased: outcome.rebased,
          rejected: outcome.rejected,
        };
      case "rejected":
        return {
          revision: outcome.revision,
          applied: [],
          rebased: [],
          rejected: outcome.rejected,
        };
      case "replayed":
        return { revision: outcome.revision, applied: outcome.applied, rebased: [], rejected: [] };
      case "conflict":
        throw new AppException(
          EDG_ERROR_CODES.conflict,
          "The document moved on; rebase and retry.",
          HttpStatus.CONFLICT,
          {
            latestRevision: outcome.latestRevision,
            opsSince: outcome.opsSince,
            ...(outcome.conflicts.length === 0 ? {} : { conflicts: outcome.conflicts }),
          },
        );
      case "too-stale":
        throw new AppException(
          EDG_ERROR_CODES.tooStale,
          "This editor is too far behind to be reconciled; reload the document.",
          HttpStatus.CONFLICT,
          { latestRevision: outcome.latestRevision, maxRevisionsBehind: MAX_OPS_SINCE_REVISIONS },
        );
    }
  }

  /**
   * Publish `edg.ops` **after** the transaction committed.
   *
   * CONTRACTS §7 fixes the payload at `{revision, ops, source}`; the envelope
   * `RoomMessage` adds `at`, which is the server time a client needs to order
   * what it receives. Publishing is fire-and-forget: realtime is a courtesy
   * channel and `GET /projects/{id}/edg` is the truth (see `realtime/README.md`).
   */
  private async publish(
    projectId: string,
    revision: number,
    ops: readonly EdgOp[],
    source: EdgSource,
  ): Promise<void> {
    await this.realtime.edgOps(projectId, { revision, ops, source });
  }

  /** Repository errors → the CONTRACTS §8 envelope. */
  private translate(error: unknown): unknown {
    if (error instanceof EdgNotFoundError) {
      return new AppException(
        EDG_ERROR_CODES.notInitialised,
        "This project has no editing document yet.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (error instanceof SnapshotNotFoundError) {
      return new AppException(
        EDG_ERROR_CODES.snapshotNotFound,
        "No snapshot was taken at that revision.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (error instanceof RestoreInvalidError) {
      // 409, not 404 or 422: the snapshot is real and well-formed, and so is the
      // document — they simply cannot both be true of the transcript as it now
      // stands, which is what a conflict is.
      return new AppException(
        EDG_ERROR_CODES.restoreInvalid,
        "That snapshot addresses words the transcript no longer has; it cannot be restored.",
        HttpStatus.CONFLICT,
        { danglingWordIds: error.danglingWordIds, issues: error.issues.slice(0, 50) },
      );
    }
    return error;
  }
}
