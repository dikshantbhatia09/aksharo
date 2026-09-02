/**
 * Building `EdgOp`s the editor emits, and inverting them for undo.
 *
 * Pure functions only — no React, no network — so the queue, the history stack
 * and every component that emits an op can be tested without a DOM. `EdgOp`
 * itself (CONTRACTS §2) is frozen in `@montaj/edg`; nothing here redefines it.
 */
import { makeWordId, parseWordId } from "@montaj/edg";
import type { EdgOp, EdgState, ScriptId, Segment, Word, WordId } from "@montaj/edg";
import { mergeOverrides } from "@montaj/render-core";

/**
 * The next unused `n` in `wordId`'s chunk, for `InsertWordAfter.newWordId`.
 *
 * `InsertWordAfter` requires the *client* to mint a word id "past every `n`
 * the chunk has used" (`packages/edg/README.md`) — the server has no
 * allocator of its own to ask, unlike a segment id, which any fresh ULID
 * satisfies. This scans the word index once for the anchor's chunk; cheap
 * next to the edit itself, since a chunk is at most ten minutes of speech.
 */
export function nextWordIdInChunk(
  words: ReadonlyMap<string, unknown>,
  anchorWordId: string,
): WordId {
  const { chunkIdx } = parseWordId(anchorWordId);
  let max = -1;
  for (const wordId of words.keys()) {
    const parsed = parseWordId(wordId);
    if (parsed.chunkIdx === chunkIdx && parsed.n > max) max = parsed.n;
  }
  return makeWordId(chunkIdx, max + 1);
}

/** The subset of `ScriptId` a `Word.scripts` slot actually has (CONTRACTS §2). */
type WordScriptId = "roman" | "native" | "en";

function isWordScript(script: ScriptId): script is WordScriptId {
  return script === "roman" || script === "native" || script === "en";
}

/** Narrows a plain string id into the frozen `WordId` template literal. */
function asWordId(id: string): WordId {
  return id as WordId;
}

/** A client-minted op id. Callers pass `newId()` from `@montaj/edg` in the app. */
export type OpIdFactory = () => string;

// ---------------------------------------------------------------------------
// Builders — one per op the transcript UI (and its keyboard map) issues.
// ---------------------------------------------------------------------------

export function editWord(
  wordId: string,
  text: string,
  script: ScriptId | undefined,
  newOpId: OpIdFactory,
): EdgOp {
  return {
    type: "EditWord",
    opId: newOpId(),
    wordId: asWordId(wordId),
    text,
    ...(script === undefined ? {} : { script }),
  };
}

export function deleteWord(wordId: string, newOpId: OpIdFactory): EdgOp {
  return { type: "DeleteWord", opId: newOpId(), wordId: asWordId(wordId) };
}

export function insertWordAfter(
  afterWordId: string,
  newWordId: string,
  text: string,
  s: number,
  e: number,
  newOpId: OpIdFactory,
): EdgOp {
  return {
    type: "InsertWordAfter",
    opId: newOpId(),
    wordId: asWordId(afterWordId),
    newWordId: asWordId(newWordId),
    text,
    s,
    e,
  };
}

/** Retimes one word; segment bounds are unaffected (they are their own op). */
export function setWordTiming(wordId: string, s: number, e: number, newOpId: OpIdFactory): EdgOp {
  return { type: "SetWordTiming", opId: newOpId(), wordId: asWordId(wordId), s, e };
}

export function splitSegment(
  segmentId: string,
  atWordId: string,
  newSegmentId: string,
  newOpId: OpIdFactory,
): EdgOp {
  return {
    type: "SplitSegment",
    opId: newOpId(),
    segmentId,
    atWordId: asWordId(atWordId),
    newSegmentId,
  };
}

export function mergeSegments(
  segmentIds: readonly string[],
  newSegmentId: string,
  newOpId: OpIdFactory,
): EdgOp {
  return { type: "MergeSegments", opId: newOpId(), segmentIds: [...segmentIds], newSegmentId };
}

export function hideSegment(segmentId: string, hidden: boolean, newOpId: OpIdFactory): EdgOp {
  return { type: "HideSegment", opId: newOpId(), segmentId, hidden };
}

export function setSegmentText(
  segmentId: string,
  script: ScriptId,
  text: string,
  newOpId: OpIdFactory,
): EdgOp {
  return { type: "SetSegmentText", opId: newOpId(), segmentId, script, text };
}

export function setEmphasis(
  segmentId: string,
  wordId: string,
  presetId: string | null,
  newOpId: OpIdFactory,
): EdgOp {
  return { type: "SetEmphasis", opId: newOpId(), segmentId, wordId: asWordId(wordId), presetId };
}

// ---------------------------------------------------------------------------
// Panel op adaptation (A16's `components/editor/panels/ops.ts`).
// ---------------------------------------------------------------------------

/**
 * The shape A16's Style/Colors/Look/Anim panels and the canvas drag handle
 * emit: `{op: "SetStyle" | "SetSegmentPosition" | "SetEmphasis", opId, ...}`.
 * Declared locally (not imported) because `components/editor/panels/ops.ts`
 * is outside this work package's file boundary and its own comment says the
 * queue — this module — does the rest: those op objects use the field name
 * `op` rather than CONTRACTS §2's `type` discriminator, and a `SetStyle`'s
 * `overrides` is a bare partial the caller expects to be merged onto the
 * scope's *current* overrides, not to replace them (`SetStyle` itself always
 * replaces wholesale — see `mergeStyleOverrides` below). Adapting that into a
 * real, batchable `EdgOp` is exactly this module's job.
 */
export interface PanelSetStyleOp {
  readonly op: "SetStyle";
  readonly opId: string;
  readonly scope: "doc" | "segment";
  readonly segmentId?: string;
  readonly styleRef?: string;
  readonly overrides?: Record<string, unknown>;
}
export interface PanelSetSegmentPositionOp {
  readonly op: "SetSegmentPosition";
  readonly opId: string;
  readonly segmentId: string;
  readonly position: { readonly x: number; readonly y: number; readonly anchor: string } | null;
}
export interface PanelSetEmphasisOp {
  readonly op: "SetEmphasis";
  readonly opId: string;
  readonly segmentId: string;
  readonly wordId: string;
  readonly presetId: string | null;
}
export type PanelOp = PanelSetStyleOp | PanelSetSegmentPositionOp | PanelSetEmphasisOp;

/** The overrides currently in effect at a `SetStyle` op's scope, before it lands. */
export function currentOverridesAt(
  hot: EdgState["hot"],
  segments: EdgState["segments"],
  scope: "doc" | "segment",
  segmentId: string | undefined,
): Record<string, unknown> | undefined {
  if (scope === "doc") {
    const inline = hot.styles.inline as { doc?: Record<string, unknown> } | undefined;
    return inline?.doc;
  }
  if (segmentId === undefined) return undefined;
  return segments.get(segmentId)?.overrides;
}

/**
 * `SetStyle` replaces its `overrides` object wholesale (`packages/edg`'s
 * `applySetStyle`) rather than merging it — deliberately, so the engine never
 * has to guess which keys a caller meant to clear. A panel control only knows
 * the one field it touched, so this module merges that partial onto the
 * scope's current overrides before the op is ever queued, using the identical
 * deep-merge `@montaj/render-core` uses to resolve a style at render time
 * (`mergeOverrides`) — the two must agree, or the picker and the preview would
 * disagree about what "the current style" is.
 */
export function mergeStyleOverrides(
  current: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return mergeOverrides(current, incoming);
}

/** Adapts one panel op into a real, CONTRACTS §2 `EdgOp`, given the state it lands on. */
export function panelOpToEdgOp(panelOp: PanelOp, state: Pick<EdgState, "hot" | "segments">): EdgOp {
  switch (panelOp.op) {
    case "SetStyle": {
      const current = currentOverridesAt(
        state.hot,
        state.segments,
        panelOp.scope,
        panelOp.segmentId,
      );
      const overrides = mergeStyleOverrides(current, panelOp.overrides);
      return {
        type: "SetStyle",
        opId: panelOp.opId,
        scope: panelOp.scope,
        ...(panelOp.segmentId === undefined ? {} : { segmentId: panelOp.segmentId }),
        ...(panelOp.styleRef === undefined ? {} : { styleRef: panelOp.styleRef }),
        ...(overrides === undefined ? {} : { overrides }),
      };
    }
    case "SetSegmentPosition":
      return {
        type: "SetSegmentPosition",
        opId: panelOp.opId,
        segmentId: panelOp.segmentId,
        position: panelOp.position,
      };
    case "SetEmphasis":
      return {
        type: "SetEmphasis",
        opId: panelOp.opId,
        segmentId: panelOp.segmentId,
        wordId: asWordId(panelOp.wordId),
        presetId: panelOp.presetId,
      };
  }
}

// ---------------------------------------------------------------------------
// Inverses — for undo. Every function reads the state *before* the op it
// inverts; the store captures that snapshot at the moment the op is queued.
// ---------------------------------------------------------------------------

export interface InverseState {
  readonly hot: EdgState["hot"];
  readonly segments: ReadonlyMap<string, Segment>;
  readonly words: ReadonlyMap<string, Word>;
}

/** Text a script displays for a word when nothing overrides it. */
function wordDisplayText(word: Word, script: "roman" | "native" | "en"): string {
  return word.scripts?.[script] ?? word.t;
}

/**
 * What a segment's script currently reads as, override or not — for
 * `SetSegmentText`'s inverse. `script` may be `"translated"` (a valid
 * `textOverrides` key per CONTRACTS §2's `ScriptId`, even though no word ever
 * carries a "translated" slot); the word fallback then has nothing to join
 * and reads as each word's base text.
 */
function segmentDisplayText(state: InverseState, segment: Segment, script: ScriptId): string {
  const override = segment.textOverrides?.[script];
  if (override !== undefined) return override;
  const parts: string[] = [];
  for (const word of state.words.values()) {
    // `words` is a `Map` in document order (`@montaj/edg`'s `WordIndex`); a
    // linear scan bounded by id equality is exactly what `wordsBetween` does.
    if (word.deleted === true) continue;
    parts.push(isWordScript(script) ? wordDisplayText(word, script) : word.t);
  }
  return parts.join(" ");
}

/**
 * The inverse of one op, computed against the state it is about to be applied
 * to. Returns zero or more ops — `[]` when the op cannot be inverted at all
 * (an anchorless `DeleteWord`, a bulk `MergeSegments`) and more than one when
 * restoring a field the primary inverse op does not carry (a merged segment's
 * discarded style).
 *
 * Two of CONTRACTS §2's sixteen ops have no id-preserving inverse by
 * construction, because word and segment ids are never reused (D28): undoing
 * a `DeleteWord` re-inserts an equivalent word under a *new* id, and undoing a
 * `MergeSegments` re-splits under the merge's id rather than the two ids that
 * existed before it. Both are visually and functionally exact — the same
 * text, timing, style and position come back — only the internal id changes,
 * exactly as a fresh `InsertWordAfter`/`SplitSegment` must.
 */
export function computeInverseOps(
  op: EdgOp,
  state: InverseState,
  newOpId: OpIdFactory,
  newId: () => string,
): EdgOp[] {
  switch (op.type) {
    case "EditWord": {
      const word = state.words.get(op.wordId);
      if (word === undefined) return [];
      const script = op.script;
      const priorText =
        script === undefined
          ? word.t
          : isWordScript(script)
            ? (word.scripts?.[script] ?? word.t)
            : word.t;
      return [editWord(op.wordId, priorText, script, newOpId)];
    }

    case "SetSegmentText": {
      const segment = state.segments.get(op.segmentId);
      if (segment === undefined) return [];
      const priorText = segmentDisplayText(state, segment, op.script);
      return [setSegmentText(op.segmentId, op.script, priorText, newOpId)];
    }

    case "DeleteWord": {
      const word = state.words.get(op.wordId);
      if (word === undefined) return [];
      const anchor = previousLiveWordId(state, op.wordId);
      if (anchor === undefined) return [];
      return [insertWordAfter(anchor, newId(), word.t, word.s, word.e, newOpId)];
    }

    case "InsertWordAfter":
      return [deleteWord(op.newWordId, newOpId)];

    case "SetWordTiming": {
      const word = state.words.get(op.wordId);
      if (word === undefined) return [];
      return [setWordTiming(op.wordId, word.s, word.e, newOpId)];
    }

    case "SplitSegment":
      return [mergeSegments([op.segmentId, op.newSegmentId], op.segmentId, newOpId)];

    case "MergeSegments": {
      if (op.segmentIds.length !== 2) return [];
      const [firstId, secondId] = op.segmentIds;
      const second = secondId === undefined ? undefined : state.segments.get(secondId);
      if (firstId === undefined || second === undefined) return [];
      const freshTail = newId();
      const ops: EdgOp[] = [splitSegment(op.newSegmentId, second.startWordId, freshTail, newOpId)];
      if (
        second.styleRef !== undefined ||
        (second.overrides !== undefined && Object.keys(second.overrides).length > 0)
      ) {
        ops.push({
          type: "SetStyle",
          opId: newOpId(),
          scope: "segment",
          segmentId: freshTail,
          ...(second.styleRef === undefined ? {} : { styleRef: second.styleRef }),
          ...(second.overrides === undefined ? {} : { overrides: second.overrides }),
        });
      }
      if (second.position !== undefined) {
        ops.push({
          type: "SetSegmentPosition",
          opId: newOpId(),
          segmentId: freshTail,
          position: second.position,
        });
      }
      if (second.hidden === true) {
        ops.push(hideSegment(freshTail, true, newOpId));
      }
      for (const [script, text] of Object.entries(second.textOverrides ?? {})) {
        ops.push(setSegmentText(freshTail, script as ScriptId, text, newOpId));
      }
      return ops;
    }

    case "HideSegment": {
      const segment = state.segments.get(op.segmentId);
      const priorHidden = segment?.hidden ?? false;
      return [hideSegment(op.segmentId, priorHidden, newOpId)];
    }

    case "SetEmphasis": {
      const segment = state.segments.get(op.segmentId);
      const prior =
        segment?.emphasis?.find((entry) => entry.wordId === op.wordId)?.presetId ?? null;
      return [setEmphasis(op.segmentId, op.wordId, prior, newOpId)];
    }

    case "SetSegmentPosition": {
      const segment = state.segments.get(op.segmentId);
      const prior = segment?.position ?? null;
      return [
        { type: "SetSegmentPosition", opId: newOpId(), segmentId: op.segmentId, position: prior },
      ];
    }

    case "SetStyle": {
      if (op.scope === "segment") {
        if (op.segmentId === undefined) return [];
        const segment = state.segments.get(op.segmentId);
        return [
          {
            type: "SetStyle",
            opId: newOpId(),
            scope: "segment",
            segmentId: op.segmentId,
            ...(segment?.styleRef === undefined ? {} : { styleRef: segment.styleRef }),
            overrides: segment?.overrides ?? {},
          },
        ];
      }
      const inline = state.hot.styles.inline as { doc?: Record<string, unknown> } | undefined;
      return [
        {
          type: "SetStyle",
          opId: newOpId(),
          scope: "doc",
          styleRef: state.hot.styles.defaultStyleId,
          overrides: inline?.doc ?? {},
        },
      ];
    }

    // Not offered by the editor's undo stack: `Resegment` replaces every
    // segment id (no inverse ops can restore the pre-resegment document, only
    // a full reload or a snapshot restore can), and `SetSegmentBounds`,
    // `SetAudio`, `SetRender`, `DecideItems` are not emitted by this WP's UI.
    default:
      return [];
  }
}

/** The live word immediately before `wordId` in document order, or `undefined`. */
function previousLiveWordId(state: InverseState, wordId: string): string | undefined {
  let previous: string | undefined;
  for (const [id, word] of state.words) {
    if (id === wordId) return previous;
    if (word.deleted !== true) previous = id;
  }
  return undefined;
}
