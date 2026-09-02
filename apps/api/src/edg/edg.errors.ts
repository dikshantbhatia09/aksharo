import { ERROR_CODES } from "../common/errors/error-codes.js";

/**
 * Error codes owned by the EDG domain (CONTRACTS §8: `namespace/slug`).
 *
 * They live here rather than in `common/errors/error-codes.ts` for the reason
 * `jobs.errors.ts` gives: that file holds the cross-cutting list named in
 * `07-api-and-contracts.md §Conventions`, and these belong to A12. The two codes
 * 07 *does* name — `edg/conflict` and `edg/stale_op` — are re-exported from
 * there rather than re-spelled, so there is exactly one definition of each.
 */
export const EDG_ERROR_CODES = {
  /** The client's `baseRevision` is behind; the body carries `{latestRevision, opsSince}`. */
  conflict: ERROR_CODES.edgConflict,
  /** An op named an id the document no longer has (07 §Conventions). */
  staleOp: ERROR_CODES.edgStaleOp,
  /**
   * Too far behind to rebase: more than {@link MAX_OPS_SINCE_REVISIONS} revisions
   * have landed, or a revision in between replaced the state wholesale (a
   * snapshot restore). The client must reload rather than replay.
   */
  tooStale: "edg/too_stale",
  /** The project has no EDG document yet — A11 creates it from the segmenter output. */
  notInitialised: "edg/not_initialised",
  /** No such snapshot revision for this document. */
  snapshotNotFound: "edg/snapshot_not_found",
  /**
   * The snapshot cannot be restored over the document as it now stands: it
   * addresses words the transcript no longer has live. The body lists them.
   */
  restoreInvalid: "edg/restore_invalid",
  /** No such pass on this document. */
  passNotFound: "edg/pass_not_found",
  /** The workspace's op-batch budget is spent (the `rate-limited` rejection reason). */
  rateLimited: ERROR_CODES.rateLimited,
} as const;

export type EdgErrorCode = (typeof EDG_ERROR_CODES)[keyof typeof EDG_ERROR_CODES];

/**
 * How far behind a client may be and still be rebased.
 *
 * The 409 carries every op accepted since `baseRevision`, so the bound is what
 * keeps a conflict response small (acceptance criterion 1: it never carries the
 * document). Past it the honest answer is "reload".
 */
export const MAX_OPS_SINCE_REVISIONS = 200;

/** Segments returned by one page of `GET /projects/{id}/edg/segments`. */
export const SEGMENT_PAGE_SIZE = 500;

/** Hard ceiling on a page, so a client cannot ask for the whole document at once. */
export const MAX_SEGMENT_PAGE_SIZE = 1000;

/** Revisions returned by one page of `GET /projects/{id}/edg/revisions`. */
export const REVISION_PAGE_SIZE = 200;
