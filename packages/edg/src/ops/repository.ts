import { type EdgHot } from "../schemas/document.js";
import { type EdgOp, type EdgSource } from "../schemas/ops.js";
import { type PassItem } from "../schemas/pass.js";
import { type Segment } from "../schemas/segment.js";

/**
 * The persistence surface the ops engine assumes — **types only**. The engine
 * itself never touches a database; A12 implements this against Prisma, and a
 * browser client can implement it against an in-memory cache, which is what lets
 * both run the identical `applyOps`/`rebaseOps` code.
 */

/** One page of the segment list (`GET /projects/{id}/edg/segments?cursor=`). */
export interface SegmentPage {
  segments: Segment[];
  /** Opaque cursor for the next page; absent on the last one. */
  cursor?: string;
}

/** The hot document plus the revision it was read at. */
export interface HotDocument {
  hot: EdgHot;
  revision: number;
}

/** A batch that lost the compare-and-swap: the client is behind (409, D29). */
export interface RevisionConflict {
  kind: "conflict";
  latestRevision: number;
  /** Ops accepted since the client's `baseRevision` — never the document itself. */
  opsSince: EdgOp[];
}

/** A batch that won the compare-and-swap. */
export interface RevisionAppended {
  kind: "appended";
  revision: number;
}

export interface AppendRevisionInput {
  edgId: string;
  /** The revision the ops were written against. */
  baseRevision: number;
  ops: readonly EdgOp[];
  /** User id, or `null` for a worker. */
  author: string | null;
  source: EdgSource;
  /** Idempotency keys, normally `ops.map((op) => op.opId)`. */
  clientOpIds?: readonly string[];
}

export interface EdgRepository {
  /** The `< 64 KB` hot document and its revision. */
  loadHot(edgId: string): Promise<HotDocument>;
  /** One page of segments in `seq` order; omit `cursor` for the first page. */
  loadSegments(edgId: string, cursor?: string): Promise<SegmentPage>;
  /** Every item of one pass. */
  loadItems(passId: string): Promise<PassItem[]>;
  /**
   * Appends one revision under compare-and-swap:
   * `UPDATE edg_documents SET revision = revision + 1 WHERE id = $1 AND revision = $2`.
   * Zero rows updated means the client is behind — the conflict carries
   * `{latestRevision, opsSince}` and never the document (D29).
   */
  appendRevision(input: AppendRevisionInput): Promise<RevisionAppended | RevisionConflict>;
  /** Revisions between materialised snapshots (D28). */
  readonly snapshotEvery: number;
}

/** The snapshot cadence CONTRACTS §2 and D28 fix: one every 100 revisions. */
export const SNAPSHOT_EVERY = 100;
