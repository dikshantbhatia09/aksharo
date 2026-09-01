import { type ApplyContext, type ApplyResult, applyOps } from "./apply.js";
import { type EdgState, fromProjection, toProjection, toTranscriptChunks } from "./state.js";
import { EDG_SCHEMA_VERSION } from "../schemas/document.js";
import { type EdgOp } from "../schemas/ops.js";
import { type EdgSnapshot } from "../schemas/snapshot.js";
import { type TranscriptChunk } from "../schemas/transcript.js";

/**
 * Snapshots: the materialised state written every
 * `EdgRepository.snapshotEvery` revisions (D28), so restoring a six-hour project
 * replays a hundred ops rather than a hundred thousand.
 */

export interface RestoreOptions {
  /** Transcript chunks, when the snapshot was stored without them. */
  chunks?: readonly TranscriptChunk[];
  /** Ids known to be dead; a snapshot alone cannot tell a dead id from an unseen one. */
  tombstones?: Iterable<string>;
  /** The idempotency window as it stood, oldest first. */
  appliedOpIds?: Iterable<string>;
}

/** Freezes a state into the value `edg_snapshots.snapshot` stores. */
export function snapshot(state: EdgState): EdgSnapshot {
  const chunks = toTranscriptChunks(state);
  return {
    schemaVersion: EDG_SCHEMA_VERSION,
    projection: toProjection(state),
    ...(chunks.length === 0 ? {} : { chunks }),
  };
}

/** Rebuilds the state a snapshot describes. */
export function restore(value: EdgSnapshot, options: RestoreOptions = {}): EdgState {
  const chunks = value.chunks ?? options.chunks;
  return fromProjection(value.projection, {
    ...(chunks === undefined ? {} : { chunks }),
    ...(options.tombstones === undefined ? {} : { tombstones: options.tombstones }),
    ...(options.appliedOpIds === undefined ? {} : { appliedOpIds: options.appliedOpIds }),
  });
}

/**
 * Restores a snapshot and applies an op log over it — the read path for any
 * revision that is not itself a snapshot.
 */
export function replay(
  value: EdgSnapshot,
  ops: readonly EdgOp[],
  ctx: ApplyContext = {},
  options: RestoreOptions = {},
): ApplyResult {
  return applyOps(restore(value, options), ops, ctx);
}
