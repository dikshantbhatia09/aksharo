import { Injectable, Logger } from "@nestjs/common";
import { type Prisma } from "@prisma/client";

import { buildWordIndex, newId, type ProjectionIssue, validateProjection } from "@montaj/edg";
import {
  applyOps,
  type EdgRepository as EdgRepositoryContract,
  type EdgState,
  fromProjection,
  type HotDocument,
  rebaseOps,
  type RevisionAppended,
  type RevisionConflict,
  type SegmentPage,
  SNAPSHOT_EVERY,
  toTranscriptChunks,
} from "@montaj/edg/ops";
import {
  type EdgHot,
  type EdgOp,
  type EdgProjection,
  type EdgSnapshot,
  EdgSnapshotSchema,
  type EdgSource,
  type OpRejection,
  type Pass,
  type PassItem,
  type Segment,
  type TranscriptChunk,
} from "@montaj/edg/schemas";

import { newestChunkRows } from "./chunk-rows.js";
import { EDG_ERROR_CODES, MAX_OPS_SINCE_REVISIONS, SEGMENT_PAGE_SIZE } from "./edg.errors.js";
import {
  type ChunkRow,
  nextWordSeqOf,
  PASS_ITEM_SELECT,
  PASS_SELECT,
  type PassItemRow,
  type PassRow,
  passColumns,
  passItemColumns,
  SEGMENT_SELECT,
  type SegmentRow,
  segmentColumns,
  toChunk,
  toHot,
  toPass,
  toPassItem,
  toSegment,
} from "./edg.rows.js";
import {
  analyseWorkingSet,
  chunkIndexOf,
  chunkWindow,
  type WorkingSetRequest,
} from "./edg.working-set.js";
import { PrismaService, type PrismaTransaction } from "../common/prisma/prisma.service.js";

/**
 * `EdgRepository` over Prisma — the persistence half of the EDG (A02b's
 * types-only interface, D28/D29).
 *
 * **The engine decides what an op means; this class decides which rows change.**
 * Nothing here interprets an op: `@montaj/edg/ops` owns `applyOps` and
 * `rebaseOps`, so the browser, a worker replaying a snapshot and this module all
 * produce the same document.
 *
 * ### The transaction
 *
 * One batch is one transaction, and it always runs in this order:
 *
 * ```
 * BEGIN
 *   SELECT … FROM edg_documents WHERE id = $1 FOR UPDATE     -- serialise writers
 *   ├─ already recorded in edg_revisions.client_op_ids? → replay the outcome, COMMIT
 *   ├─ baseRevision < revision → load opsSince, rebaseOps    -- pure, reads no rows
 *   │    └─ any `conflict` → 409 {latestRevision, opsSince}
 *   ├─ load the WORKING SET (edg.working-set.ts), not the document
 *   ├─ applyOps on it, minting revision+1
 *   ├─ write the rows that actually changed (segments, items, passes, chunks)
 *   ├─ UPDATE edg_documents SET revision = revision + 1 … WHERE revision = $base
 *   │    RETURNING revision                                  -- zero rows → conflict
 *   ├─ INSERT edg_revisions (ops, client_op_ids, author, source)
 *   └─ every SNAPSHOT_EVERY-th revision: INSERT edg_snapshots
 * COMMIT
 * ```
 *
 * The row lock and the compare-and-swap do different jobs and both are needed.
 * The lock is what makes "read the revision, decide, write the revision" atomic,
 * so `edg_documents.revision` rises by exactly one per accepted batch under any
 * amount of concurrency. The CAS is what makes that true even if a future caller
 * forgets the lock, or Postgres hands out the row after a failover: it is the
 * invariant written into the statement rather than into a convention.
 */

/** Rows one batch may read and write, keyed for diffing. */
interface WorkingSet {
  readonly segments: Map<string, SegmentRow>;
  readonly passes: Map<string, PassRow>;
  readonly items: Map<string, PassItemRow>;
  readonly chunks: Map<number, ChunkRow>;
  readonly tombstones: string[];
}

/** The document row, as the `FOR UPDATE` read returns it. */
interface DocumentRow {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly hot: EdgHot;
}

/** One side of a text collision, so the client can show the user both. */
export interface TextConflict {
  readonly opId: string;
  /** `segment` for `SetSegmentText`, `word` for `EditWord`. */
  readonly target: "segment" | "word";
  readonly targetId: string;
  readonly script?: string;
  /** The text the client submitted. */
  readonly yours: string;
  /** The text the winning revision wrote. */
  readonly theirs: string;
}

export interface CommitInput {
  readonly edgId: string;
  readonly baseRevision: number;
  readonly ops: readonly EdgOp[];
  readonly clientOpIds: readonly string[];
  readonly author: string | null;
  readonly source: EdgSource;
  /** Leave filler words out when a `Resegment` rebuilds the captions. */
  readonly dropFillers?: boolean;
}

export type CommitOutcome =
  | {
      readonly kind: "applied";
      readonly revision: number;
      readonly applied: string[];
      readonly rebased: string[];
      readonly rejected: OpRejection[];
      /** The ops **as applied** — rebased where a rule rewrote them. Realtime carries these. */
      readonly ops: EdgOp[];
      readonly snapshotAt?: number;
    }
  | {
      /** Nothing landed: every op was rejected. The revision did not move. */
      readonly kind: "rejected";
      readonly revision: number;
      readonly applied: string[];
      readonly rebased: string[];
      readonly rejected: OpRejection[];
    }
  | {
      /** The batch was recorded by an earlier request; the recorded outcome is returned. */
      readonly kind: "replayed";
      readonly revision: number;
      readonly applied: string[];
    }
  | {
      readonly kind: "conflict";
      readonly latestRevision: number;
      readonly opsSince: EdgOp[];
      readonly conflicts: TextConflict[];
    }
  | { readonly kind: "too-stale"; readonly latestRevision: number };

/** Thrown inside the transaction to roll it back; never leaves this file. */
class CommitAbort extends Error {
  override readonly name = "CommitAbort";
  constructor(readonly outcome: CommitOutcome) {
    super("edg commit aborted");
  }
}

/** Raised when the document row is missing entirely (A11 has not initialised it). */
export class EdgNotFoundError extends Error {
  override readonly name = "EdgNotFoundError";
  readonly code = EDG_ERROR_CODES.notInitialised;
}

/** Raised when a write lost the row it had locked — a bug or a failover, never routine. */
export class EdgRaceLostError extends Error {
  override readonly name = "EdgRaceLostError";
  readonly code = EDG_ERROR_CODES.conflict;
}

/** Raised when a restore names a revision that has no snapshot. */
export class SnapshotNotFoundError extends Error {
  override readonly name = "SnapshotNotFoundError";
  readonly code = EDG_ERROR_CODES.snapshotNotFound;
}

/**
 * Raised when a snapshot cannot be restored over the document as it now stands.
 *
 * The transcript is not rolled back with the captions (words live in their own
 * table, and a spelling fixed after the snapshot must stay fixed), so a snapshot
 * old enough to predate a `DeleteWord` can name a word that is no longer live.
 * Writing it would leave a caption bounded by a word nothing can render. The
 * restore is refused instead, naming the ids.
 */
export class RestoreInvalidError extends Error {
  override readonly name = "RestoreInvalidError";
  readonly code = EDG_ERROR_CODES.restoreInvalid;
  constructor(
    readonly danglingWordIds: string[],
    readonly issues: ProjectionIssue[],
  ) {
    super(`snapshot cannot be restored: ${issues.length} projection issue(s)`);
  }
}

/** Field-by-field identity, in a fixed key order, so a diff is a string compare. */
function canonicalSegment(segment: Segment): string {
  return JSON.stringify([
    segment.seq,
    segment.startWordId,
    segment.endWordId,
    segment.startMs,
    segment.endMs,
    segment.styleRef ?? null,
    segment.textOverrides ?? {},
    segment.emphasis ?? [],
    segment.position ?? null,
    segment.overrides ?? null,
    segment.hidden === true,
  ]);
}

function canonicalItem(item: PassItem): string {
  return JSON.stringify([
    item.passId,
    item.kind,
    item.startMs,
    item.endMs,
    item.payload,
    item.keyframesRef ?? null,
    item.confidence ?? null,
    item.reason ?? null,
    item.state,
    item.licenceSnapshot ?? null,
  ]);
}

function canonicalPass(pass: Pass): string {
  return JSON.stringify([pass.type, pass.engine, pass.params, pass.status, pass.jobId ?? null]);
}

/** Words with their keys in a stable order, so re-serialisation is not a change. */
function canonicalWords(words: unknown): string {
  return JSON.stringify(words, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) ordered[key] = record[key];
    return ordered;
  });
}

@Injectable()
export class EdgRepository implements EdgRepositoryContract {
  private readonly logger = new Logger(EdgRepository.name);

  /** CONTRACTS §2 and D28: one materialised snapshot every 100 revisions. */
  readonly snapshotEvery = SNAPSHOT_EVERY;

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The hot document (`< 64 KB`) and the revision it was read at. */
  async loadHot(edgId: string): Promise<HotDocument> {
    const row = await this.prisma.edgDocument.findUnique({
      where: { id: edgId },
      select: { revision: true, doc: true },
    });
    if (row === null) throw new EdgNotFoundError();
    return { hot: toHot(row.doc), revision: row.revision };
  }

  /**
   * One page of live segments in `seq` order.
   *
   * The cursor is the previous page's last `seq`, which is stable under
   * concurrent edits in a way an offset is not: an insert three pages back
   * cannot make a later page skip a caption. `edg_segments.seq` is
   * `text COLLATE "C"`, so `ORDER BY seq` is the comparison `compareSeqKeys()`
   * makes in `@montaj/edg` (see `prisma/sql/README.md`).
   */
  async loadSegments(
    edgId: string,
    cursor?: string,
    limit = SEGMENT_PAGE_SIZE,
  ): Promise<SegmentPage> {
    const rows = await this.prisma.edgSegment.findMany({
      where: {
        edgId,
        deletedAtRev: null,
        ...(cursor === undefined || cursor === "" ? {} : { seq: { gt: cursor } }),
      },
      orderBy: { seq: "asc" },
      take: limit + 1,
      select: SEGMENT_SELECT,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      segments: page.map(toSegment),
      ...(rows.length > limit && last !== undefined ? { cursor: last.seq } : {}),
    };
  }

  /** Every item of one pass, oldest first on the timeline. */
  async loadItems(passId: string): Promise<PassItem[]> {
    const rows = await this.prisma.edgPassItem.findMany({
      where: { passId },
      orderBy: [{ startMs: "asc" }, { id: "asc" }],
      select: PASS_ITEM_SELECT,
    });
    return rows.map(toPassItem);
  }

  /** Every pass on a document, with its items. */
  async loadPasses(edgId: string): Promise<Pass[]> {
    const passes = await this.prisma.edgPass.findMany({
      where: { edgId },
      orderBy: { id: "asc" },
      select: PASS_SELECT,
    });
    const items = await this.prisma.edgPassItem.findMany({
      where: { edgId },
      orderBy: [{ startMs: "asc" }, { id: "asc" }],
      select: PASS_ITEM_SELECT,
    });
    const byPass = new Map<string, PassItem[]>();
    for (const row of items) {
      const bucket = byPass.get(row.passId);
      if (bucket === undefined) byPass.set(row.passId, [toPassItem(row)]);
      else bucket.push(toPassItem(row));
    }
    return passes.map((pass) => toPass(pass, byPass.get(pass.id) ?? []));
  }

  /** The revision log, oldest first, for `GET /projects/{id}/edg/revisions`. */
  async loadRevisions(
    edgId: string,
    from: number,
    limit: number,
  ): Promise<
    {
      revision: number;
      ops: EdgOp[];
      clientOpIds: string[];
      author: string | null;
      source: EdgSource;
      at: Date;
    }[]
  > {
    const rows = await this.prisma.edgRevision.findMany({
      where: { edgId, revision: { gte: from } },
      orderBy: { revision: "asc" },
      take: limit,
      select: {
        revision: true,
        ops: true,
        clientOpIds: true,
        author: true,
        source: true,
        at: true,
      },
    });
    return rows.map((row) => ({
      revision: row.revision,
      ops: row.ops as unknown as EdgOp[],
      clientOpIds: row.clientOpIds,
      author: row.author,
      source: row.source,
      at: row.at,
    }));
  }

  /** Snapshot revisions available for `POST …/snapshots/{n}/restore`, newest first. */
  async listSnapshots(edgId: string): Promise<{ revision: number; createdAt: Date }[]> {
    return this.prisma.edgSnapshot.findMany({
      where: { edgId },
      orderBy: { revision: "desc" },
      select: { revision: true, createdAt: true },
    });
  }

  /** The transcript chunks of a document, in chunk order. */
  async loadChunks(transcriptId: string, only?: readonly number[]): Promise<TranscriptChunk[]> {
    const rows = await this.readChunkRows(this.prisma, transcriptId, only);
    return rows.map(toChunk);
  }

  // -------------------------------------------------------------------------
  // The write path
  // -------------------------------------------------------------------------

  /**
   * A02b's interface method: append one revision under compare-and-swap.
   *
   * It answers only "did it land, and at which revision" — never the document
   * (D29). {@link commit} is the same transaction with the per-op verdicts the
   * HTTP layer needs; this is the shape the engine's consumers were promised.
   */
  async appendRevision(input: {
    edgId: string;
    baseRevision: number;
    ops: readonly EdgOp[];
    author: string | null;
    source: EdgSource;
    clientOpIds?: readonly string[];
  }): Promise<RevisionAppended | RevisionConflict> {
    const outcome = await this.commit({
      edgId: input.edgId,
      baseRevision: input.baseRevision,
      ops: input.ops,
      clientOpIds: input.clientOpIds ?? input.ops.map((op) => op.opId),
      author: input.author,
      source: input.source,
    });

    switch (outcome.kind) {
      case "applied":
      case "rejected":
      case "replayed":
        return { kind: "appended", revision: outcome.revision };
      case "conflict":
        return {
          kind: "conflict",
          latestRevision: outcome.latestRevision,
          opsSince: outcome.opsSince,
        };
      case "too-stale":
        return { kind: "conflict", latestRevision: outcome.latestRevision, opsSince: [] };
    }
  }

  /** The full write path: rebase, apply, persist, compare-and-swap, snapshot. */
  async commit(input: CommitInput): Promise<CommitOutcome> {
    try {
      return await this.prisma.withTransaction(
        async (tx) => this.commitInTransaction(tx, input),
        // A `Resegment` over a 9,000-segment document rewrites every row; the
        // default 10 s is enough for a caption edit and not for that.
        { timeoutMs: 30_000, maxWaitMs: 10_000 },
      );
    } catch (error) {
      if (error instanceof CommitAbort) return error.outcome;
      throw error;
    }
  }

  private async commitInTransaction(
    tx: PrismaTransaction,
    input: CommitInput,
  ): Promise<CommitOutcome> {
    const document = await this.lockDocument(tx, input.edgId);

    const recorded = await this.recordedOpIds(tx, input);
    if (recorded.replay !== undefined) return recorded.replay;

    const { rebased, rejected: rebaseRejected } = await this.rebaseAgainstHistory(
      tx,
      document,
      input,
    );

    const request = analyseWorkingSet(rebased);
    const working = await this.loadWorkingSet(tx, document, request);
    const state = this.stateOf(document, working, recorded.known);

    const result = applyOps(state, rebased, {
      source: input.source,
      revision: document.revision + 1,
      newId,
      ...(input.dropFillers === undefined ? {} : { dropFillers: input.dropFillers }),
    });

    // `applied` is what the CLIENT is told landed, which includes an op the
    // idempotency window swallowed; `changed` is what actually edited the
    // document, and only that is worth a revision or a realtime frame.
    const acknowledged = new Set(result.applied);
    const changed = new Set(result.applied.filter((opId) => !result.skipped.includes(opId)));
    const rejections = [...rebaseRejected, ...result.rejected];
    const appliedOps = rebased.filter((op) => changed.has(op.opId));
    const rewritten = new Set(
      rebased.filter((op) => !input.ops.some((original) => original === op)).map((op) => op.opId),
    );

    if (appliedOps.length === 0) {
      // Nothing to record: a revision with no ops means "the state was replaced"
      // to every reader of the log, and this batch replaced nothing.
      return {
        kind: "rejected",
        revision: document.revision,
        applied: [...acknowledged].filter((opId) => !rewritten.has(opId)),
        rebased: [...acknowledged].filter((opId) => rewritten.has(opId)),
        rejected: rejections,
      };
    }

    const revision = document.revision + 1;
    const hot = await this.persist(tx, document, working, result.state, revision, request);
    await this.compareAndSwap(tx, document, hot, revision, input.author);

    await tx.edgRevision.create({
      data: {
        id: newId(),
        edgId: document.id,
        revision,
        ops: appliedOps as unknown as Prisma.InputJsonValue,
        clientOpIds: [...input.clientOpIds],
        author: input.author,
        source: input.source,
      },
    });

    const snapshotAt = await this.maybeSnapshot(tx, document.id, hot, revision);

    return {
      kind: "applied",
      revision,
      applied: [...acknowledged].filter((opId) => !rewritten.has(opId)),
      rebased: [...acknowledged].filter((opId) => rewritten.has(opId)),
      rejected: rejections,
      ops: appliedOps,
      ...(snapshotAt === undefined ? {} : { snapshotAt }),
    };
  }

  /**
   * `SELECT … FOR UPDATE` on the document row.
   *
   * Every writer queues here, which is what makes the read-decide-write below
   * atomic. It is a row lock, not a table lock: two projects never wait on each
   * other, and a reader is never blocked at all.
   */
  private async lockDocument(tx: PrismaTransaction, edgId: string): Promise<DocumentRow> {
    const rows = await tx.$queryRaw<
      { id: string; project_id: string; revision: number; doc: unknown }[]
    >`SELECT id, project_id, revision, doc FROM edg_documents WHERE id = ${edgId} FOR UPDATE`;

    const row = rows[0];
    if (row === undefined) throw new EdgNotFoundError();
    return {
      id: row.id,
      projectId: row.project_id,
      revision: row.revision,
      hot: toHot(row.doc as never),
    };
  }

  /**
   * Which of this batch's op ids the document has already recorded.
   *
   * `edg_revisions.client_op_ids` is the idempotency record — a separate table
   * would be a second thing to prune — and a GIN index makes the overlap test an
   * index lookup (`prisma/sql/0006-a12-edg.sql`).
   *
   * Two outcomes fall out of the one query. When **every** id is already
   * recorded, the batch is a retry of a response the client lost, and the
   * revision the first attempt produced is returned without touching the
   * document. When **some** are, the client retried with new ops appended; the
   * recorded ids seed the engine's idempotency window, so `applyOps` reports them
   * as applied without editing the document again and only the new ops land. The
   * alternative — re-applying them — would double an insert and fail a
   * `SplitSegment` outright, because an id is never reused.
   */
  private async recordedOpIds(
    tx: PrismaTransaction,
    input: CommitInput,
  ): Promise<{ replay?: CommitOutcome; known: string[] }> {
    if (input.clientOpIds.length === 0) return { known: [] };

    const rows = await tx.edgRevision.findMany({
      where: { edgId: input.edgId, clientOpIds: { hasSome: [...input.clientOpIds] } },
      orderBy: { revision: "desc" },
      take: 32,
      select: { revision: true, clientOpIds: true },
    });
    if (rows.length === 0) return { known: [] };

    const incoming = new Set(input.clientOpIds);
    const known = new Set<string>();
    for (const row of rows) {
      for (const opId of row.clientOpIds) if (incoming.has(opId)) known.add(opId);
    }

    const newest = rows[0];
    if (newest !== undefined && input.clientOpIds.every((opId) => known.has(opId))) {
      return {
        replay: { kind: "replayed", revision: newest.revision, applied: [...input.clientOpIds] },
        known: [...known],
      };
    }
    return { known: [...known] };
  }

  /**
   * Bring a batch written against an older revision up to date.
   *
   * `rebaseOps` reads **ops only**, never the document, which is why the browser
   * can run the identical transform to reconcile its optimistic queue. A
   * `conflict` verdict is the one thing the server may not decide on the user's
   * behalf — it means two people typed different text into the same caption — so
   * it aborts into the 409 that carries both.
   */
  private async rebaseAgainstHistory(
    tx: PrismaTransaction,
    document: DocumentRow,
    input: CommitInput,
  ): Promise<{ rebased: EdgOp[]; rejected: OpRejection[] }> {
    if (input.baseRevision === document.revision) {
      return { rebased: [...input.ops], rejected: [] };
    }
    if (input.baseRevision > document.revision) {
      // A base the document has never reached: the client is talking about
      // another document, or has been rolled back. Either way it must re-read.
      throw new CommitAbort({
        kind: "conflict",
        latestRevision: document.revision,
        opsSince: [],
        conflicts: [],
      });
    }
    if (document.revision - input.baseRevision > MAX_OPS_SINCE_REVISIONS) {
      throw new CommitAbort({ kind: "too-stale", latestRevision: document.revision });
    }

    const rows = await tx.edgRevision.findMany({
      where: { edgId: document.id, revision: { gt: input.baseRevision } },
      orderBy: { revision: "asc" },
      select: { revision: true, ops: true },
    });

    const opsSince: EdgOp[] = [];
    for (const row of rows) {
      const ops = row.ops as unknown as EdgOp[];
      if (ops.length === 0) {
        // A revision with no ops replaced the state wholesale (a snapshot
        // restore, or the first revision A11 writes). There is nothing to rebase
        // against, so the only honest answer is "reload".
        throw new CommitAbort({ kind: "too-stale", latestRevision: document.revision });
      }
      opsSince.push(...ops);
    }

    const { rebased, rejected } = rebaseOps(input.ops, opsSince);
    const conflicts = rejected.filter((rejection) => rejection.reason === "conflict");
    if (conflicts.length > 0) {
      throw new CommitAbort({
        kind: "conflict",
        latestRevision: document.revision,
        opsSince,
        conflicts: describeConflicts(conflicts, input.ops, opsSince),
      });
    }

    return { rebased, rejected };
  }

  // -------------------------------------------------------------------------
  // Working set
  // -------------------------------------------------------------------------

  private async loadWorkingSet(
    tx: PrismaTransaction,
    document: DocumentRow,
    request: WorkingSetRequest,
  ): Promise<WorkingSet> {
    const segments = new Map<string, SegmentRow>();
    const tombstones: string[] = [];

    if (request.wholeDocument) {
      const rows = await tx.edgSegment.findMany({
        where: { edgId: document.id, deletedAtRev: null },
        orderBy: { seq: "asc" },
        select: SEGMENT_SELECT,
      });
      for (const row of rows) segments.set(row.id, row);
    } else if (request.segmentIds.length > 0 || request.boundaryWordIds.length > 0) {
      const window = await this.readSegmentWindow(tx, document.id, request);
      for (const row of window.live) segments.set(row.id, row);
      tombstones.push(...window.tombstoned);
    }

    if (!request.wholeDocument && request.timingWordIds.length > 0) {
      const rows = await this.resolveTimingSegments(tx, document, request.timingWordIds);
      for (const row of rows) segments.set(row.id, row);
    }

    const { passes, items } = await this.readPassWindow(tx, document.id, request);
    const chunks = await this.readChunkWindow(tx, document, request, segments);

    return { segments, passes, items, chunks, tombstones };
  }

  /**
   * The addressed segments, everything between them, and one neighbour either
   * side — plus any segment a deleted word bounds, wherever it sits.
   */
  private async readSegmentWindow(
    tx: PrismaTransaction,
    edgId: string,
    request: WorkingSetRequest,
  ): Promise<{ live: SegmentRow[]; tombstoned: string[] }> {
    // Dead ids come back from the same read as the live ones: an op against a
    // tombstoned segment must be `stale` rather than `unknown-id`, and that is
    // one lookup, not two.
    const named =
      request.segmentIds.length === 0
        ? []
        : await tx.edgSegment.findMany({
            where: { edgId, id: { in: [...request.segmentIds] } },
            select: SEGMENT_SELECT,
          });

    const addressed = named.filter((row) => row.deletedAtRev === null);
    const tombstoned = named.filter((row) => row.deletedAtRev !== null).map((row) => row.id);

    const rows: SegmentRow[] = [...addressed];

    if (addressed.length > 0) {
      const seqs = addressed.map((row) => row.seq).sort();
      const first = seqs[0] as string;
      const last = seqs[seqs.length - 1] as string;

      rows.push(
        ...(await tx.edgSegment.findMany({
          where: { edgId, deletedAtRev: null, seq: { gte: first, lte: last } },
          orderBy: { seq: "asc" },
          select: SEGMENT_SELECT,
        })),
      );

      const before = await tx.edgSegment.findFirst({
        where: { edgId, deletedAtRev: null, seq: { lt: first } },
        orderBy: { seq: "desc" },
        select: SEGMENT_SELECT,
      });
      if (before !== null) rows.push(before);

      const after = await tx.edgSegment.findFirst({
        where: { edgId, deletedAtRev: null, seq: { gt: last } },
        orderBy: { seq: "asc" },
        select: SEGMENT_SELECT,
      });
      if (after !== null) rows.push(after);
    }

    if (request.boundaryWordIds.length > 0) {
      const words = [...request.boundaryWordIds];
      rows.push(
        ...(await tx.edgSegment.findMany({
          where: {
            edgId,
            deletedAtRev: null,
            OR: [{ startWordId: { in: words } }, { endWordId: { in: words } }],
          },
          select: SEGMENT_SELECT,
        })),
      );
    }

    return { live: rows, tombstoned };
  }

  /**
   * The live segments that currently *contain* each of `wordIds` (not merely
   * bound it — `SetWordTiming` carries no `segmentId`, unlike every other word
   * op, so the engine's containment check needs the segment loaded whichever
   * word inside it moved).
   *
   * A word's own row is not addressable by id in SQL (words live in a chunk's
   * JSONB), so this reads each word's current `s`/`e` from its chunk first, then
   * asks for every live segment whose `[startMs, endMs]` overlaps it. A segment
   * that overlaps a word's time span without actually bounding it by word id is
   * over-fetched rather than missed — `applyOps`'s `containingSegment` still
   * ranks by word position, not by this query's ms overlap, and false positives
   * cost an extra loaded row, never a wrong verdict.
   */
  private async resolveTimingSegments(
    tx: PrismaTransaction,
    document: DocumentRow,
    wordIds: readonly string[],
  ): Promise<SegmentRow[]> {
    const chunkIdxs = [...new Set(wordIds.map(chunkIndexOf).filter((idx) => idx !== undefined))];
    if (chunkIdxs.length === 0) return [];

    const rows = await this.readChunkRows(tx, document.hot.transcript.transcriptId, chunkIdxs);
    const byId = new Map<string, { s: number; e: number }>();
    for (const row of rows) {
      for (const word of toChunk(row).words) byId.set(word.wid, { s: word.s, e: word.e });
    }

    const ranges = wordIds
      .map((wordId) => byId.get(wordId))
      .filter((range): range is { s: number; e: number } => range !== undefined);
    if (ranges.length === 0) return [];

    return tx.edgSegment.findMany({
      where: {
        edgId: document.id,
        deletedAtRev: null,
        OR: ranges.map((range) => ({ startMs: { lte: range.e }, endMs: { gte: range.s } })),
      },
      select: SEGMENT_SELECT,
    });
  }

  private async readPassWindow(
    tx: PrismaTransaction,
    edgId: string,
    request: WorkingSetRequest,
  ): Promise<{ passes: Map<string, PassRow>; items: Map<string, PassItemRow> }> {
    const passes = new Map<string, PassRow>();
    const items = new Map<string, PassItemRow>();

    const wantsItems = request.itemIds.length > 0;
    const wantsPasses = request.passIds.length > 0;
    if (!wantsItems && !wantsPasses) return { passes, items };

    const itemRows = await tx.edgPassItem.findMany({
      where: {
        edgId,
        OR: [
          ...(wantsItems ? [{ id: { in: [...request.itemIds] } }] : []),
          ...(wantsPasses ? [{ passId: { in: [...request.passIds] } }] : []),
        ],
      },
      select: PASS_ITEM_SELECT,
    });
    for (const row of itemRows) items.set(row.id, row);

    const passIds = new Set<string>([...request.passIds, ...itemRows.map((row) => row.passId)]);
    const passRows = await tx.edgPass.findMany({
      where: { edgId, id: { in: [...passIds] } },
      select: PASS_SELECT,
    });
    for (const row of passRows) passes.set(row.id, row);

    return { passes, items };
  }

  /**
   * The transcript chunks the batch can touch: those its word ids name, those the
   * loaded segments' boundaries name, and one chunk either side of each — because
   * `wordAfter` and `previousLiveWord` walk document order across the boundary.
   */
  private async readChunkWindow(
    tx: PrismaTransaction,
    document: DocumentRow,
    request: WorkingSetRequest,
    segments: Map<string, SegmentRow>,
  ): Promise<Map<number, ChunkRow>> {
    const transcriptId = document.hot.transcript.transcriptId;
    const chunks = new Map<number, ChunkRow>();

    // The common edit — text, style, position, hidden — never asks the engine a
    // question about a word, and a 10-minute chunk is the largest row the write
    // path could read. Not reading it is most of what keeps the p95 flat.
    if (!request.needsWords) return chunks;

    if (request.wholeDocument) {
      for (const row of await this.readChunkRows(tx, transcriptId)) chunks.set(row.chunkIdx, row);
      return chunks;
    }

    const wordIds = new Set<string>(request.wordIds);
    for (const segment of segments.values()) {
      wordIds.add(segment.startWordId);
      wordIds.add(segment.endWordId);
    }
    if (wordIds.size === 0) return chunks;

    // The window is asked for by index rather than checked first: a chunk the
    // transcript does not have simply returns no row, which is one round trip
    // fewer than looking the available indices up.
    const wanted = chunkWindow(wordIds);
    if (wanted.length === 0) return chunks;

    for (const row of await this.readChunkRows(tx, transcriptId, wanted)) {
      chunks.set(row.chunkIdx, row);
    }
    return chunks;
  }

  /**
   * Chunk rows, newest revision per `chunk_idx` (unbounded — the live document
   * always wants the truly newest, whatever revision it carries).
   *
   * Shared with `TranscriptsRepository` via `newestChunkRows` (A11d): both read
   * `transcript_chunks` the same way, because a word edit here is exactly the
   * event that used to leave a pinned transcript read looking at zero rows.
   */
  private async readChunkRows(
    client: PrismaTransaction,
    transcriptId: string,
    only?: readonly number[],
  ): Promise<ChunkRow[]> {
    return newestChunkRows(client, transcriptId, only === undefined ? {} : { only });
  }

  /** The engine state a working set stands for. */
  private stateOf(
    document: DocumentRow,
    working: WorkingSet,
    appliedOpIds: readonly string[] = [],
  ): EdgState {
    const itemsByPass = new Map<string, PassItem[]>();
    for (const row of working.items.values()) {
      const bucket = itemsByPass.get(row.passId);
      if (bucket === undefined) itemsByPass.set(row.passId, [toPassItem(row)]);
      else bucket.push(toPassItem(row));
    }

    const projection: EdgProjection = {
      ...document.hot,
      segments: [...working.segments.values()].map(toSegment),
      passes: [...working.passes.values()].map((row) => toPass(row, itemsByPass.get(row.id) ?? [])),
    };

    return fromProjection(projection, {
      chunks: [...working.chunks.values()].map(toChunk),
      tombstones: working.tombstones,
      appliedOpIds,
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Write the rows the batch actually changed and return the hot document to
   * store.
   *
   * Order matters: tombstones go first, then updates, then inserts. Two live
   * segments may not share a `seq` (`edg_segments_live_seq_idx`), and a merge
   * frees the key a split is about to claim.
   */
  private async persist(
    tx: PrismaTransaction,
    document: DocumentRow,
    working: WorkingSet,
    after: EdgState,
    revision: number,
    request: WorkingSetRequest,
  ): Promise<EdgHot> {
    await this.persistSegments(tx, document.id, working, after, revision);
    await this.persistPasses(tx, document.id, working, after);

    let hot: EdgHot = { ...after.hot, meta: { ...after.hot.meta, revision } };
    if (request.touchesWords) {
      const changed = await this.persistWords(tx, working, after);
      if (changed > 0) {
        const transcript = await tx.transcript.update({
          where: { id: document.hot.transcript.transcriptId },
          data: { currentRevision: { increment: 1 } },
          select: { currentRevision: true },
        });
        hot = {
          ...hot,
          transcript: { ...hot.transcript, revision: transcript.currentRevision },
        };
      }
    }
    return hot;
  }

  private async persistSegments(
    tx: PrismaTransaction,
    edgId: string,
    working: WorkingSet,
    after: EdgState,
    revision: number,
  ): Promise<void> {
    const removed: string[] = [];
    for (const id of working.segments.keys()) {
      if (!after.segments.has(id)) removed.push(id);
    }
    if (removed.length > 0) {
      await tx.edgSegment.updateMany({
        where: { edgId, id: { in: removed } },
        data: { deletedAtRev: revision },
      });
    }

    const inserts: Segment[] = [];
    for (const [id, segment] of after.segments) {
      const before = working.segments.get(id);
      if (before === undefined) {
        inserts.push(segment);
        continue;
      }
      if (canonicalSegment(toSegment(before)) === canonicalSegment(segment)) continue;
      await tx.edgSegment.update({
        where: { id },
        data: segmentColumns(segment, revision),
      });
    }

    if (inserts.length > 0) {
      await tx.edgSegment.createMany({
        data: inserts.map((segment) => ({ edgId, ...segmentColumns(segment, revision) })),
      });
    }
  }

  private async persistPasses(
    tx: PrismaTransaction,
    edgId: string,
    working: WorkingSet,
    after: EdgState,
  ): Promise<void> {
    for (const [passId, record] of after.passes) {
      const before = working.passes.get(passId);
      const pass: Pass = { ...record, items: [] };
      if (before === undefined) {
        await tx.edgPass.create({ data: { edgId, ...passColumns(pass) } });
        continue;
      }
      if (canonicalPass(toPass(before, [])) === canonicalPass(pass)) continue;
      await tx.edgPass.update({ where: { id: passId }, data: passColumns(pass) });
    }

    const removed: string[] = [];
    for (const id of working.items.keys()) if (!after.items.has(id)) removed.push(id);
    if (removed.length > 0) await tx.edgPassItem.deleteMany({ where: { id: { in: removed } } });

    const inserts: PassItem[] = [];
    for (const [itemId, item] of after.items) {
      const before = working.items.get(itemId);
      if (before === undefined) {
        inserts.push(item);
        continue;
      }
      if (canonicalItem(toPassItem(before)) === canonicalItem(item)) continue;
      await tx.edgPassItem.update({ where: { id: itemId }, data: passItemColumns(item) });
    }
    if (inserts.length > 0) {
      await tx.edgPassItem.createMany({
        data: inserts.map((item) => ({ edgId, ...passItemColumns(item) })),
      });
    }
  }

  /**
   * Patch the transcript chunks a word edit touched — and only those.
   *
   * A word edit is a change to one 10-minute chunk of one transcript, so it is
   * one `UPDATE` of one row's `words` JSONB. `next_word_seq` rises with it,
   * because word ids are allocated from it and never reused (06 invariant 4).
   * Returns how many rows changed, which is what tells the caller whether the
   * transcript revision has to move.
   */
  private async persistWords(
    tx: PrismaTransaction,
    working: WorkingSet,
    after: EdgState,
  ): Promise<number> {
    let changed = 0;
    for (const chunk of toTranscriptChunks(after)) {
      const before = working.chunks.get(chunk.chunkIdx);
      if (before === undefined) continue;
      const nextWordSeq = nextWordSeqOf(chunk, before.nextWordSeq);
      if (
        canonicalWords(before.words) === canonicalWords(chunk.words) &&
        nextWordSeq === before.nextWordSeq
      ) {
        continue;
      }
      await tx.transcriptChunk.update({
        where: { id: before.id },
        data: { words: chunk.words as unknown as Prisma.InputJsonValue, nextWordSeq },
      });
      changed += 1;
    }
    return changed;
  }

  /**
   * `UPDATE … WHERE revision = $base RETURNING revision`.
   *
   * Zero rows means somebody else moved the document between the lock and here,
   * which cannot happen while the lock is held — and is exactly what this
   * statement is for if it ever does.
   */
  private async compareAndSwap(
    tx: PrismaTransaction,
    document: DocumentRow,
    hot: EdgHot,
    revision: number,
    author: string | null,
  ): Promise<void> {
    const updated = await tx.$queryRaw<{ revision: number }[]>`
      UPDATE edg_documents
         SET revision = revision + 1,
             doc = ${JSON.stringify(hot)}::jsonb,
             updated_by = ${author},
             updated_at = now()
       WHERE id = ${document.id}
         AND revision = ${document.revision}
       RETURNING revision`;

    const row = updated[0];
    if (row === undefined || row.revision !== revision) {
      this.logger.warn(
        { edgId: document.id, expected: document.revision },
        "edg compare-and-swap lost the row it had locked",
      );
      throw new CommitAbort({
        kind: "conflict",
        latestRevision: document.revision,
        opsSince: [],
        conflicts: [],
      });
    }
  }

  /**
   * One materialised snapshot every {@link SNAPSHOT_EVERY} revisions (D28).
   *
   * The stored value carries the projection and **not** the transcript chunks:
   * they live in their own table and would multiply a six-hour project's words by
   * one copy per hundred edits. `restore` is given them from there.
   */
  private async maybeSnapshot(
    tx: PrismaTransaction,
    edgId: string,
    hot: EdgHot,
    revision: number,
  ): Promise<number | undefined> {
    if (revision % this.snapshotEvery !== 0) return undefined;
    const projection = await this.readProjection(tx, edgId, hot);
    const snapshot: EdgSnapshot = EdgSnapshotSchema.parse({
      schemaVersion: hot.meta.schemaVersion,
      projection,
    });
    await tx.edgSnapshot.create({
      data: {
        id: newId(),
        edgId,
        revision,
        schemaVersion: hot.meta.schemaVersion,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    return revision;
  }

  /** The whole document as one value: hot state plus every live segment and pass. */
  private async readProjection(
    tx: PrismaTransaction,
    edgId: string,
    hot: EdgHot,
  ): Promise<EdgProjection> {
    const segments = await tx.edgSegment.findMany({
      where: { edgId, deletedAtRev: null },
      orderBy: { seq: "asc" },
      select: SEGMENT_SELECT,
    });
    const passRows = await tx.edgPass.findMany({
      where: { edgId },
      orderBy: { id: "asc" },
      select: PASS_SELECT,
    });
    const itemRows = await tx.edgPassItem.findMany({
      where: { edgId },
      orderBy: [{ startMs: "asc" }, { id: "asc" }],
      select: PASS_ITEM_SELECT,
    });

    const byPass = new Map<string, PassItem[]>();
    for (const row of itemRows) {
      const bucket = byPass.get(row.passId);
      if (bucket === undefined) byPass.set(row.passId, [toPassItem(row)]);
      else bucket.push(toPassItem(row));
    }

    return {
      ...hot,
      segments: segments.map(toSegment),
      passes: passRows.map((row) => toPass(row, byPass.get(row.id) ?? [])),
    };
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  /**
   * Restore the state a snapshot recorded as a **new** revision.
   *
   * History is never rewritten (D28): the op log keeps every revision that came
   * after the snapshot, and the restore is appended on top of them. The new
   * revision carries no ops, which is the log's way of saying "the state was
   * replaced" — anybody rebasing across it is told to reload rather than handed
   * an op list that cannot express what happened.
   *
   * The transcript is deliberately **not** restored: words live in their own
   * table with their own revision, and rolling captions back must not un-correct
   * a spelling the user fixed afterwards.
   */
  async restoreSnapshot(input: {
    edgId: string;
    snapshotRevision: number;
    author: string | null;
    source: EdgSource;
  }): Promise<{ revision: number; segments: number }> {
    try {
      return await this.prisma.withTransaction(
        async (tx) => {
          const document = await this.lockDocument(tx, input.edgId);

          const row = await tx.edgSnapshot.findUnique({
            where: { edgId_revision: { edgId: input.edgId, revision: input.snapshotRevision } },
            select: { snapshot: true },
          });
          if (row === null) throw new SnapshotNotFoundError();

          const stored = EdgSnapshotSchema.parse(row.snapshot);
          const revision = document.revision + 1;

          // The document the restore would write. The words are the
          // transcript's, not the document's, so the live reference is kept
          // rather than the one the snapshot froze.
          const target: EdgProjection = {
            ...stored.projection,
            meta: { ...stored.projection.meta, revision },
            transcript: document.hot.transcript,
          };

          await this.assertRestorable(tx, document, target);

          const existing = await tx.edgSegment.findMany({
            where: { edgId: input.edgId },
            select: SEGMENT_SELECT,
          });
          const wanted = new Map(target.segments.map((segment) => [segment.id, segment]));

          const removed = existing
            .filter((segment) => segment.deletedAtRev === null && !wanted.has(segment.id))
            .map((segment) => segment.id);
          if (removed.length > 0) {
            await tx.edgSegment.updateMany({
              where: { id: { in: removed } },
              data: { deletedAtRev: revision },
            });
          }

          const known = new Map(existing.map((segment) => [segment.id, segment]));
          const inserts: Segment[] = [];
          for (const segment of wanted.values()) {
            const before = known.get(segment.id);
            if (before === undefined) {
              inserts.push(segment);
              continue;
            }
            if (
              before.deletedAtRev === null &&
              canonicalSegment(toSegment(before)) === canonicalSegment(segment)
            ) {
              continue;
            }
            await tx.edgSegment.update({
              where: { id: segment.id },
              data: segmentColumns(segment, revision),
            });
          }
          if (inserts.length > 0) {
            await tx.edgSegment.createMany({
              data: inserts.map((segment) => ({
                edgId: input.edgId,
                ...segmentColumns(segment, revision),
              })),
            });
          }

          await this.restorePasses(tx, input.edgId, target);

          const hot: EdgHot = {
            meta: target.meta,
            media: target.media,
            transcript: target.transcript,
            canvas: target.canvas,
            styles: target.styles,
            ...(target.audio === undefined ? {} : { audio: target.audio }),
            ...(target.render === undefined ? {} : { render: target.render }),
          };

          await this.compareAndSwap(tx, document, hot, revision, input.author);
          await tx.edgRevision.create({
            data: {
              id: newId(),
              edgId: input.edgId,
              revision,
              ops: [],
              clientOpIds: [],
              author: input.author,
              source: input.source,
            },
          });
          await this.maybeSnapshot(tx, input.edgId, hot, revision);

          return { revision, segments: target.segments.length };
        },
        { timeoutMs: 30_000, maxWaitMs: 10_000 },
      );
    } catch (error) {
      if (error instanceof CommitAbort) throw new EdgRaceLostError();
      throw error;
    }
  }

  /**
   * Refuse a restore that would write a caption nobody can render.
   *
   * The transcript is deliberately not rolled back with the document, so a
   * snapshot old enough to predate a `DeleteWord` can still name that word. The
   * projection is therefore checked against the transcript **as it now stands**
   * before a single row is written: `validateProjection` for every invariant the
   * document has to hold (D28 — unique ids, ascending `seq`, time order, word
   * ranges that run forwards, emphasis inside its own segment, item ownership),
   * with a word index built from the **live** words only. A tombstoned word is
   * as good as a missing one here: it will never render, so a segment bounded by
   * it is exactly as broken as one bounded by an id that never existed.
   *
   * The whole transcript is read for this. A restore is a rare, deliberate,
   * human action — unlike an op batch, which is why that path has a working set
   * and this one does not.
   */
  private async assertRestorable(
    tx: PrismaTransaction,
    document: DocumentRow,
    target: EdgProjection,
  ): Promise<void> {
    const rows = await this.readChunkRows(tx, document.hot.transcript.transcriptId);
    const live: TranscriptChunk[] = rows
      .map(toChunk)
      .map((chunk) => ({ ...chunk, words: chunk.words.filter((word) => word.deleted !== true) }));
    const wordIndex = buildWordIndex(live);

    const issues = validateProjection(target, { wordIndex });
    if (issues.length === 0) return;

    const dangling = new Set<string>();
    for (const segment of target.segments) {
      const referenced = [
        segment.startWordId,
        segment.endWordId,
        ...(segment.emphasis ?? []).map((entry) => entry.wordId),
      ];
      for (const wordId of referenced) if (!wordIndex.has(wordId)) dangling.add(wordId);
    }

    this.logger.warn(
      { edgId: document.id, issues: issues.length, dangling: dangling.size },
      "snapshot restore refused: the transcript has moved on",
    );
    throw new RestoreInvalidError([...dangling].sort(), issues);
  }

  private async restorePasses(
    tx: PrismaTransaction,
    edgId: string,
    target: EdgProjection,
  ): Promise<void> {
    const wantedItems = new Map<string, PassItem>();
    for (const pass of target.passes)
      for (const item of pass.items) wantedItems.set(item.itemId, item);

    const existingItems = await tx.edgPassItem.findMany({ where: { edgId }, select: { id: true } });
    const removed = existingItems
      .filter((item) => !wantedItems.has(item.id))
      .map((item) => item.id);
    if (removed.length > 0) await tx.edgPassItem.deleteMany({ where: { id: { in: removed } } });

    for (const pass of target.passes) {
      await tx.edgPass.upsert({
        where: { id: pass.passId },
        create: { edgId, ...passColumns(pass) },
        update: passColumns(pass),
      });
    }
    for (const item of wantedItems.values()) {
      await tx.edgPassItem.upsert({
        where: { id: item.itemId },
        create: { edgId, ...passItemColumns(item) },
        update: passItemColumns(item),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Creation (A11 calls this through `EdgService.initialise`)
  // -------------------------------------------------------------------------

  /**
   * Create the document, its first segments and revision 1 in one transaction.
   *
   * Revision 1 carries no ops — nothing preceded it, so there is nothing to
   * replay — and is snapshotted immediately, which gives every later restore a
   * floor to stand on.
   */
  async createDocument(input: {
    edgId: string;
    projectId: string;
    hot: EdgHot;
    segments: readonly Segment[];
    /**
     * Brief C04b §1: the local project's transcript, handed over by "Upload
     * to cloud" alongside its document. Written as generation 1 of a fresh
     * `Transcript` row (`hot.transcript.transcriptId`/`.language`) so every
     * word-addressed op resolves on the uploaded project from the moment it
     * lands — omitted, a project imports with no addressable transcript,
     * same as before this WP.
     */
    chunks?: readonly TranscriptChunk[];
    author: string | null;
    source: EdgSource;
  }): Promise<{ edgId: string; revision: number; segments: number }> {
    return this.prisma.withTransaction(
      async (tx) => {
        const hot: EdgHot = { ...input.hot, meta: { ...input.hot.meta, revision: 1 } };

        if (input.chunks !== undefined && input.chunks.length > 0) {
          await tx.transcript.create({
            data: {
              id: hot.transcript.transcriptId,
              projectId: input.projectId,
              language: hot.transcript.language,
              currentRevision: hot.transcript.revision,
            },
          });
          await tx.transcriptChunk.createMany({
            data: input.chunks.map((chunk) => ({
              id: newId(),
              transcriptId: hot.transcript.transcriptId,
              revision: hot.transcript.revision,
              chunkIdx: chunk.chunkIdx,
              startMs: chunk.startMs,
              endMs: chunk.endMs,
              words: chunk.words as unknown as Prisma.InputJsonValue,
              nextWordSeq: nextWordSeqOf(chunk, 0),
            })),
          });
        }

        await tx.edgDocument.create({
          data: {
            id: input.edgId,
            projectId: input.projectId,
            revision: 1,
            schemaVersion: hot.meta.schemaVersion,
            doc: hot as unknown as Prisma.InputJsonValue,
            updatedBy: input.author,
          },
        });

        if (input.segments.length > 0) {
          await tx.edgSegment.createMany({
            data: input.segments.map((segment) => ({
              edgId: input.edgId,
              ...segmentColumns(segment, 1),
            })),
          });
        }

        await tx.edgRevision.create({
          data: {
            id: newId(),
            edgId: input.edgId,
            revision: 1,
            ops: [],
            clientOpIds: [],
            author: input.author,
            source: input.source,
          },
        });

        const projection = await this.readProjection(tx, input.edgId, hot);
        await tx.edgSnapshot.create({
          data: {
            id: newId(),
            edgId: input.edgId,
            revision: 1,
            schemaVersion: hot.meta.schemaVersion,
            snapshot: EdgSnapshotSchema.parse({
              schemaVersion: hot.meta.schemaVersion,
              projection,
            }) as unknown as Prisma.InputJsonValue,
          },
        });

        return { edgId: input.edgId, revision: 1, segments: input.segments.length };
      },
      // A real 3-hour/54k-word transcript's first-ever segmentation writes
      // tens of thousands of segment rows plus the revision-1 snapshot in
      // this one transaction; 30s (this file's usual op-commit budget,
      // sized for an ordinary edit batch) measured short at that scale on a
      // dev machine — observed at ~39s (A15b perf run) — and Prisma's
      // interactive-transaction timeout does not resize itself to the
      // document being created. 120s gives real headroom without leaving an
      // ordinary small-transcript create waiting any longer than before.
      { timeoutMs: 120_000, maxWaitMs: 10_000 },
    );
  }

  /** The projection of the current state, used by the restore and export paths. */
  async projectionOf(edgId: string): Promise<EdgProjection> {
    const { hot } = await this.loadHot(edgId);
    return this.readProjection(this.prisma, edgId, hot);
  }
}

/**
 * Turn the engine's `conflict` verdicts into the pair of texts the editor shows.
 *
 * The rebase table reports *that* two writers wrote the same caption; the texts
 * are in the ops themselves — the client's in the batch it sent, the winner's in
 * `opsSince` — so nothing has to be read back out of the document for this.
 */
function describeConflicts(
  rejections: readonly OpRejection[],
  incoming: readonly EdgOp[],
  opsSince: readonly EdgOp[],
): TextConflict[] {
  const conflicts: TextConflict[] = [];

  for (const rejection of rejections) {
    const mine = incoming.find((op) => op.opId === rejection.opId);
    if (mine === undefined) continue;

    if (mine.type === "SetSegmentText") {
      const winner = [...opsSince]
        .reverse()
        .find(
          (op) =>
            op.type === "SetSegmentText" &&
            op.segmentId === mine.segmentId &&
            op.script === mine.script,
        );
      conflicts.push({
        opId: mine.opId,
        target: "segment",
        targetId: mine.segmentId,
        script: mine.script,
        yours: mine.text,
        theirs: winner !== undefined && winner.type === "SetSegmentText" ? winner.text : "",
      });
      continue;
    }

    if (mine.type === "EditWord") {
      const winner = [...opsSince]
        .reverse()
        .find((op) => op.type === "EditWord" && op.wordId === mine.wordId);
      conflicts.push({
        opId: mine.opId,
        target: "word",
        targetId: mine.wordId,
        ...(mine.script === undefined ? {} : { script: mine.script }),
        yours: mine.text,
        theirs: winner !== undefined && winner.type === "EditWord" ? winner.text : "",
      });
    }
  }

  return conflicts;
}
