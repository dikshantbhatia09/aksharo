import { type EdgProjection, EdgProjectionSchema } from "./schemas/document.js";
import { compareSeqKeys } from "./seq.js";
import { type WordIndex, wordPositions } from "./transcript-index.js";

/**
 * Document invariants that no single field schema can express (05 §4). Every
 * writer — the ops engine (A02b), the API and the workers — runs a projection
 * through this before persisting a snapshot.
 */

/** What went wrong. Codes are stable; the message is for humans. */
export type ProjectionIssueCode =
  /** The value does not match `EdgProjectionSchema`. */
  | "schema"
  /** Two segments (or passes, or items) share an id. */
  | "duplicate-id"
  /** Two segments share a `seq`, so their order is undefined. */
  | "duplicate-seq"
  /** `segments` is not ascending by `seq`. */
  | "segment-order"
  /** `startMs` is after `endMs`. */
  | "time-order"
  /** A word id is not in the transcript index. */
  | "unknown-word"
  /** `startWordId` sits after `endWordId` in document order. */
  | "word-order"
  /** An emphasis points outside its segment's word range. */
  | "emphasis-out-of-range"
  /** A pass item claims a `passId` that is not its parent pass. */
  | "item-pass-mismatch"
  /** The item and its payload disagree about which keyframe curve to use. */
  | "keyframes-ref-mismatch";

export interface ProjectionIssue {
  code: ProjectionIssueCode;
  /** Dotted path into the projection, e.g. `segments[3].endWordId`. */
  path: string;
  message: string;
}

export interface ValidateProjectionOptions {
  /**
   * The transcript index the segments address. Word-level checks (existence,
   * ordering, emphasis range) only run when it is supplied — the API has it,
   * a plugin posting a hot document may not.
   */
  wordIndex?: WordIndex;
}

/** Thrown by `assertValidProjection`. */
export class ProjectionInvalidError extends Error {
  override readonly name = "ProjectionInvalidError";
  constructor(readonly issues: ProjectionIssue[]) {
    super(
      `invalid EDG projection: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}

function checkSegments(
  projection: EdgProjection,
  issues: ProjectionIssue[],
  index?: WordIndex,
): void {
  const positions = index === undefined ? undefined : wordPositions(index);
  const seenIds = new Set<string>();
  const seenSeqs = new Set<string>();
  let previousSeq: string | undefined;

  for (const [i, segment] of projection.segments.entries()) {
    const at = `segments[${i}]`;
    if (seenIds.has(segment.id)) {
      issues.push({
        code: "duplicate-id",
        path: `${at}.id`,
        message: `duplicate segment id ${segment.id}`,
      });
    }
    seenIds.add(segment.id);

    if (seenSeqs.has(segment.seq)) {
      issues.push({
        code: "duplicate-seq",
        path: `${at}.seq`,
        message: `duplicate seq ${segment.seq}`,
      });
    }
    seenSeqs.add(segment.seq);

    if (previousSeq !== undefined && compareSeqKeys(previousSeq, segment.seq) >= 0) {
      issues.push({
        code: "segment-order",
        path: `${at}.seq`,
        message: `segments must ascend by seq, ${segment.seq} follows ${previousSeq}`,
      });
    }
    previousSeq = segment.seq;

    if (segment.startMs > segment.endMs) {
      issues.push({
        code: "time-order",
        path: `${at}.endMs`,
        message: `startMs ${segment.startMs} is after endMs ${segment.endMs}`,
      });
    }

    if (positions === undefined) continue;

    const start = positions.get(segment.startWordId);
    const end = positions.get(segment.endWordId);
    if (start === undefined) {
      issues.push({
        code: "unknown-word",
        path: `${at}.startWordId`,
        message: `${segment.startWordId} is not in the transcript`,
      });
    }
    if (end === undefined) {
      issues.push({
        code: "unknown-word",
        path: `${at}.endWordId`,
        message: `${segment.endWordId} is not in the transcript`,
      });
    }
    if (start !== undefined && end !== undefined && start > end) {
      issues.push({
        code: "word-order",
        path: `${at}.endWordId`,
        message: `${segment.startWordId} is after ${segment.endWordId} in the transcript`,
      });
    }

    for (const [e, emphasis] of (segment.emphasis ?? []).entries()) {
      const position = positions.get(emphasis.wordId);
      if (position === undefined) {
        issues.push({
          code: "unknown-word",
          path: `${at}.emphasis[${e}].wordId`,
          message: `${emphasis.wordId} is not in the transcript`,
        });
        continue;
      }
      if (start !== undefined && end !== undefined && (position < start || position > end)) {
        issues.push({
          code: "emphasis-out-of-range",
          path: `${at}.emphasis[${e}].wordId`,
          message: `${emphasis.wordId} is outside ${segment.startWordId}..${segment.endWordId}`,
        });
      }
    }
  }
}

function checkPasses(projection: EdgProjection, issues: ProjectionIssue[]): void {
  const seenPassIds = new Set<string>();
  const seenItemIds = new Set<string>();

  for (const [p, pass] of projection.passes.entries()) {
    const at = `passes[${p}]`;
    if (seenPassIds.has(pass.passId)) {
      issues.push({
        code: "duplicate-id",
        path: `${at}.passId`,
        message: `duplicate pass id ${pass.passId}`,
      });
    }
    seenPassIds.add(pass.passId);

    for (const [i, item] of pass.items.entries()) {
      const itemAt = `${at}.items[${i}]`;
      if (seenItemIds.has(item.itemId)) {
        issues.push({
          code: "duplicate-id",
          path: `${itemAt}.itemId`,
          message: `duplicate item id ${item.itemId}`,
        });
      }
      seenItemIds.add(item.itemId);

      if (item.passId !== pass.passId) {
        issues.push({
          code: "item-pass-mismatch",
          path: `${itemAt}.passId`,
          message: `item claims pass ${item.passId} but sits under ${pass.passId}`,
        });
      }

      if (item.startMs > item.endMs) {
        issues.push({
          code: "time-order",
          path: `${itemAt}.endMs`,
          message: `startMs ${item.startMs} is after endMs ${item.endMs}`,
        });
      }

      const payloadRef =
        item.kind === "zoom" || item.kind === "reframe" ? item.payload.keyframesRef : undefined;
      if (
        item.keyframesRef !== undefined &&
        payloadRef !== undefined &&
        item.keyframesRef !== payloadRef
      ) {
        issues.push({
          code: "keyframes-ref-mismatch",
          path: `${itemAt}.keyframesRef`,
          message: `item points at ${item.keyframesRef}, payload at ${payloadRef}`,
        });
      }
    }
  }
}

/**
 * Checks a projection and returns everything wrong with it. An empty array means
 * the document is well formed: it parses, its ids are unique, its segments
 * ascend by `seq`, its times run forwards and — when a `wordIndex` is supplied —
 * its word references exist, run forwards and contain their own emphasis.
 */
export function validateProjection(
  projection: unknown,
  options: ValidateProjectionOptions = {},
): ProjectionIssue[] {
  const parsed = EdgProjectionSchema.safeParse(projection);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: "schema" as const,
      path: issue.path.length === 0 ? "$" : issue.path.join("."),
      message: issue.message,
    }));
  }

  const issues: ProjectionIssue[] = [];
  checkSegments(parsed.data, issues, options.wordIndex);
  checkPasses(parsed.data, issues);
  return issues;
}

/** Parses and checks a projection, throwing `ProjectionInvalidError` on the first bad document. */
export function assertValidProjection(
  projection: unknown,
  options: ValidateProjectionOptions = {},
): EdgProjection {
  const issues = validateProjection(projection, options);
  if (issues.length > 0) throw new ProjectionInvalidError(issues);
  return EdgProjectionSchema.parse(projection);
}
