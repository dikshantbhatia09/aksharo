import { type WordId } from "../ids.js";
import { type EdgOp, type OpRejection, type OpRejectionReason } from "../schemas/ops.js";

/**
 * The rebase transform table (D29, `07 §Transcripts & EDG`).
 *
 * A client writes ops against `baseRevision`. If the document has moved on, the
 * server replays the incoming batch through this function against `opsSince` —
 * every op accepted between `baseRevision` and now — before applying it. Only
 * the ops survive; nothing here reads the document, which is what lets the same
 * table run in the browser to reconcile an optimistic queue.
 *
 * The rules, in the order they fire:
 *
 * 1. **`Resegment` since the base** replaced every segment id, so every
 *    segment-addressed op is `stale-after-resegment`. Word-level and
 *    document-level ops survive it.
 * 2. **A word deleted since the base** makes any op naming it `stale`.
 * 3. **A concurrent edit of the same text** is a `conflict`, never a silent
 *    drop: `EditWord` on a word another writer edited, and `SetSegmentText` on a
 *    `(segment, script)` another writer wrote. The API turns both into the 409
 *    that carries the two texts, and the client decides which survives.
 * 4. **A segment merged away since the base** is remapped onto the segment that
 *    swallowed it where the op still means something (`SetEmphasis`,
 *    `SetSegmentPosition`, `HideSegment`, `SetStyle`, `SplitSegment`,
 *    `MergeSegments`), and is `stale` where it does not (`SetSegmentText` and
 *    `SetSegmentBounds` would overwrite the merged line). A `MergeSegments` list
 *    also grows the children of any segment split since the base, so the ids it
 *    names are still neighbours.
 * 5. **Last writer wins per `(target, field)`**: an op is `rebased-away` only
 *    when every field it writes was already written by a later revision. Ops on
 *    other fields of the same segment survive untouched. `DecideItems` and
 *    `SetAudio` are narrowed instead of dropped when only part of them lost.
 *    Caption text is the exception: dropping it would throw away what the user
 *    just typed, so a `SetSegmentText` that lost is a `conflict` (rule 3).
 * 6. Anything that would still name a tombstoned id after all that is `stale`,
 *    so a rebased batch can never resurrect a dead id.
 */

export interface RebaseResult {
  /** The ops to apply, in the incoming order, rewritten where a rule demanded it. */
  rebased: EdgOp[];
  /** Ops that did not survive the transform. */
  rejected: OpRejection[];
}

/** What `opsSince` did to the document, in the shape the transforms need. */
interface Since {
  /** Merged-away segment id → the segment that swallowed it (chased to the end). */
  remap: Map<string, string>;
  /** Segment id → the ids split off it, in document order. */
  splitChildren: Map<string, string[]>;
  /** Segment ids that no longer exist. */
  deadSegments: Set<string>;
  /** Words tombstoned since the base. */
  deletedWords: Set<string>;
  /** Words another writer corrected since the base. */
  editedWords: Set<string>;
  /** `(target, field)` keys a later revision already wrote. */
  fields: Set<string>;
  /** `true` when the whole segment list was rebuilt. */
  resegmented: boolean;
}

function canonical(remap: ReadonlyMap<string, string>, segmentId: string): string {
  let current = segmentId;
  const seen = new Set<string>([current]);
  for (;;) {
    const next = remap.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

const SEGMENT_FIELD = {
  text: (segmentId: string, script: string) => `seg:${segmentId}:text:${script}`,
  bounds: (segmentId: string) => `seg:${segmentId}:bounds`,
  emphasis: (segmentId: string, wordId: string) => `seg:${segmentId}:emphasis:${wordId}`,
  position: (segmentId: string) => `seg:${segmentId}:position`,
  hidden: (segmentId: string) => `seg:${segmentId}:hidden`,
  style: (segmentId: string) => `seg:${segmentId}:style`,
} as const;

const DOC_STYLE_FIELD = "doc:style";
const DOC_SEGMENTS_FIELD = "doc:segments";
const PROTECTED_FIELD = "doc:protected";
const audioField = (key: string) => `doc:audio:${key}`;
const RENDER_FIELD = "doc:render:presets";
const itemField = (itemId: string) => `item:${itemId}`;
const timingField = (wordId: string) => `timing:${wordId}`;
const passField = (passId: string) => `pass:${passId}`;

/** Reads `opsSince` once and collects everything the transforms ask about. */
export function analyseOpsSince(opsSince: readonly EdgOp[]): Since {
  const since: Since = {
    remap: new Map(),
    splitChildren: new Map(),
    deadSegments: new Set(),
    deletedWords: new Set(),
    editedWords: new Set(),
    fields: new Set(),
    resegmented: false,
  };

  for (const op of opsSince) {
    switch (op.type) {
      case "MergeSegments": {
        for (const segmentId of op.segmentIds) {
          const target = canonical(since.remap, segmentId);
          since.remap.set(target, op.newSegmentId);
          since.remap.set(segmentId, op.newSegmentId);
          since.deadSegments.add(segmentId);
          since.deadSegments.add(target);
        }
        since.deadSegments.delete(op.newSegmentId);
        break;
      }
      case "SplitSegment": {
        const parent = canonical(since.remap, op.segmentId);
        const children = since.splitChildren.get(parent) ?? [];
        // The tail lands immediately after its parent, ahead of earlier splits.
        since.splitChildren.set(parent, [op.newSegmentId, ...children]);
        since.fields.add(SEGMENT_FIELD.bounds(parent));
        break;
      }
      case "SetSegmentText":
        since.fields.add(SEGMENT_FIELD.text(canonical(since.remap, op.segmentId), op.script));
        break;
      case "SetSegmentBounds":
        since.fields.add(SEGMENT_FIELD.bounds(canonical(since.remap, op.segmentId)));
        break;
      case "SetEmphasis":
        since.fields.add(
          SEGMENT_FIELD.emphasis(canonical(since.remap, op.segmentId), op.wordId as string),
        );
        break;
      case "SetSegmentPosition":
        since.fields.add(SEGMENT_FIELD.position(canonical(since.remap, op.segmentId)));
        break;
      case "HideSegment":
        since.fields.add(SEGMENT_FIELD.hidden(canonical(since.remap, op.segmentId)));
        break;
      case "SetStyle":
        since.fields.add(
          op.scope === "doc" || op.segmentId === undefined
            ? DOC_STYLE_FIELD
            : SEGMENT_FIELD.style(canonical(since.remap, op.segmentId)),
        );
        break;
      case "EditWord":
        since.editedWords.add(op.wordId);
        break;
      case "DeleteWord":
        since.deletedWords.add(op.wordId);
        break;
      case "Resegment":
        since.resegmented = true;
        since.fields.add(DOC_SEGMENTS_FIELD);
        break;
      case "DecideItems":
        for (const itemId of op.itemIds) since.fields.add(itemField(itemId));
        break;
      case "MergePass":
        since.fields.add(passField(op.pass.passId));
        break;
      case "SetAudio":
        if (op.clean !== undefined) since.fields.add(audioField("clean"));
        if (op.ducking !== undefined) since.fields.add(audioField("ducking"));
        break;
      case "SetRender":
        if (op.presets !== undefined) since.fields.add(RENDER_FIELD);
        break;
      case "InsertWordAfter":
        break;
      case "SetProtectedRanges":
        since.fields.add(PROTECTED_FIELD);
        break;
      case "SetWordTiming":
        since.fields.add(timingField(op.wordId));
        break;
      default: {
        const exhaustive: never = op;
        throw new Error(`unhandled op ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return since;
}

/** Op types whose target segment id may be moved onto the segment that ate it. */
const REMAPPABLE = new Set([
  "SetEmphasis",
  "SetSegmentPosition",
  "HideSegment",
  "SetStyle",
  "SplitSegment",
  "MergeSegments",
]);

/** Op types addressed at a segment, which a `Resegment` invalidates wholesale. */
const SEGMENT_ADDRESSED = new Set([
  "SetSegmentText",
  "SetSegmentBounds",
  "SplitSegment",
  "MergeSegments",
  "SetEmphasis",
  "SetSegmentPosition",
  "HideSegment",
]);

function isSegmentAddressed(op: EdgOp): boolean {
  if (op.type === "SetStyle") return op.scope === "segment";
  return SEGMENT_ADDRESSED.has(op.type);
}

/** Word ids an op names, which must all still be alive for it to survive. */
function referencedWords(op: EdgOp): WordId[] {
  switch (op.type) {
    case "SetSegmentBounds": {
      const words: WordId[] = [];
      if (op.startWordId !== undefined) words.push(op.startWordId);
      if (op.endWordId !== undefined) words.push(op.endWordId);
      return words;
    }
    case "SplitSegment":
      return [op.atWordId];
    case "SetEmphasis":
      return [op.wordId];
    case "EditWord":
    case "DeleteWord":
      return [op.wordId];
    case "InsertWordAfter":
      return [op.wordId];
    case "SetWordTiming":
      return [op.wordId];
    default:
      return [];
  }
}

/** Segment ids an op names. */
function referencedSegments(op: EdgOp): string[] {
  switch (op.type) {
    case "SetSegmentText":
    case "SetSegmentBounds":
    case "SplitSegment":
    case "SetEmphasis":
    case "SetSegmentPosition":
    case "HideSegment":
      return [op.segmentId];
    case "MergeSegments":
      return [...op.segmentIds];
    case "SetStyle":
      return op.scope === "segment" && op.segmentId !== undefined ? [op.segmentId] : [];
    default:
      return [];
  }
}

/** `segmentId` followed by every segment split off it, in document order. */
function expandSplits(since: Since, segmentId: string, seen: Set<string>): string[] {
  if (seen.has(segmentId)) return [];
  seen.add(segmentId);
  const expanded = [segmentId];
  for (const child of since.splitChildren.get(segmentId) ?? []) {
    expanded.push(...expandSplits(since, child, seen));
  }
  return expanded;
}

/** Moves an op's segment ids onto the segments that swallowed them. */
function remapSegments(op: EdgOp, since: Since): EdgOp {
  switch (op.type) {
    case "SetEmphasis":
    case "SetSegmentPosition":
    case "HideSegment":
    case "SplitSegment":
      return { ...op, segmentId: canonical(since.remap, op.segmentId) };
    case "SetStyle":
      return op.segmentId === undefined
        ? op
        : { ...op, segmentId: canonical(since.remap, op.segmentId) };
    case "MergeSegments": {
      const seen = new Set<string>();
      const segmentIds: string[] = [];
      for (const segmentId of op.segmentIds) {
        for (const expanded of expandSplits(since, canonical(since.remap, segmentId), new Set())) {
          if (seen.has(expanded) || expanded === op.newSegmentId) continue;
          seen.add(expanded);
          segmentIds.push(expanded);
        }
      }
      return { ...op, segmentIds };
    }
    default:
      return op;
  }
}

/** The `(target, field)` keys an op writes. Empty means "nothing to lose". */
function writtenFields(op: EdgOp): string[] {
  switch (op.type) {
    case "SetSegmentText":
      return [SEGMENT_FIELD.text(op.segmentId, op.script)];
    case "SetSegmentBounds":
    case "SplitSegment":
      return [SEGMENT_FIELD.bounds(op.segmentId)];
    case "MergeSegments":
      return op.segmentIds.map((segmentId) => SEGMENT_FIELD.bounds(segmentId));
    case "SetEmphasis":
      return [SEGMENT_FIELD.emphasis(op.segmentId, op.wordId)];
    case "SetSegmentPosition":
      return [SEGMENT_FIELD.position(op.segmentId)];
    case "HideSegment":
      return [SEGMENT_FIELD.hidden(op.segmentId)];
    case "SetStyle":
      return [
        op.scope === "doc" || op.segmentId === undefined
          ? DOC_STYLE_FIELD
          : SEGMENT_FIELD.style(op.segmentId),
      ];
    case "Resegment":
      return [DOC_SEGMENTS_FIELD];
    case "MergePass":
      return [passField(op.pass.passId)];
    case "SetRender":
      return op.presets === undefined ? [] : [RENDER_FIELD];
    case "SetWordTiming":
      return [timingField(op.wordId)];
    case "SetProtectedRanges":
      return [PROTECTED_FIELD];
    default:
      return [];
  }
}

/**
 * Ops that lose only part of themselves: the parts a later revision already
 * wrote are dropped, and what remains is still worth applying.
 */
function narrow(op: EdgOp, since: Since): EdgOp | undefined {
  if (op.type === "DecideItems") {
    const itemIds = op.itemIds.filter((itemId) => !since.fields.has(itemField(itemId)));
    if (itemIds.length === 0) return undefined;
    return itemIds.length === op.itemIds.length ? op : { ...op, itemIds };
  }
  if (op.type === "SetAudio") {
    const clean = since.fields.has(audioField("clean")) ? undefined : op.clean;
    const ducking = since.fields.has(audioField("ducking")) ? undefined : op.ducking;
    if (clean === undefined && ducking === undefined) return undefined;
    return { ...op, clean, ducking };
  }
  return op;
}

function reject(rejected: OpRejection[], op: EdgOp, reason: OpRejectionReason, message: string) {
  rejected.push({ opId: op.opId, reason, message: message.slice(0, 500) });
}

/**
 * Rebases a batch written against an older revision onto the ops accepted since.
 *
 * The result is ordered like `incoming`; ops that survived keep their `opId`, so
 * the caller can report exactly which of the client's ops landed.
 */
export function rebaseOps(incoming: readonly EdgOp[], opsSince: readonly EdgOp[]): RebaseResult {
  const since = analyseOpsSince(opsSince);
  const rebased: EdgOp[] = [];
  const rejected: OpRejection[] = [];

  for (const op of incoming) {
    if (since.resegmented && isSegmentAddressed(op)) {
      reject(rejected, op, "stale-after-resegment", "Resegment replaced every segment id");
      continue;
    }

    const words = referencedWords(op);
    const deadWord = words.find((wordId) => since.deletedWords.has(wordId));
    if (deadWord !== undefined) {
      reject(rejected, op, "stale", `word ${deadWord} was deleted since the base revision`);
      continue;
    }

    if (op.type === "EditWord" && since.editedWords.has(op.wordId)) {
      reject(rejected, op, "conflict", `word ${op.wordId} was edited by another writer`);
      continue;
    }

    const segments = referencedSegments(op);
    const merged = segments.filter((segmentId) => since.remap.has(segmentId));
    if (merged.length > 0 && !REMAPPABLE.has(op.type)) {
      reject(rejected, op, "stale", `segment ${merged[0] ?? ""} was merged away`);
      continue;
    }

    const moved = remapSegments(op, since);
    if (moved.type === "MergeSegments" && moved.segmentIds.length < 2) {
      reject(rejected, op, "rebased-away", "the segments to merge are already one segment");
      continue;
    }

    const fields = writtenFields(moved);
    if (fields.length > 0 && fields.every((field) => since.fields.has(field))) {
      if (moved.type === "SetSegmentText") {
        // Text is the one field a silent last-writer-wins would lose real work
        // on, so the client is told and resolves it; the 409 carries both texts.
        reject(
          rejected,
          op,
          "conflict",
          `segment ${moved.segmentId} was edited in ${moved.script} by another writer`,
        );
      } else {
        reject(rejected, op, "rebased-away", "a later revision already wrote the same field");
      }
      continue;
    }

    const narrowed = narrow(moved, since);
    if (narrowed === undefined) {
      reject(rejected, op, "rebased-away", "a later revision already decided every target");
      continue;
    }

    const stillDead = [...referencedSegments(narrowed), ...referencedWords(narrowed)].find(
      (id) => since.deadSegments.has(id) || since.deletedWords.has(id),
    );
    if (stillDead !== undefined) {
      reject(rejected, op, "stale", `${stillDead} no longer exists`);
      continue;
    }

    rebased.push(narrowed);
  }

  return { rebased, rejected };
}
