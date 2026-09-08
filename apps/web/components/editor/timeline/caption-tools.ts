/**
 * K06: the real Caption Tools dropdown's Actions/Timing batch-op builders.
 *
 * Pure functions only — no React, no store — so every batch this WP ships can
 * be unit-tested by applying its output through `@montaj/edg`'s own `applyOps`
 * and asserting the resulting document, exactly the discipline
 * `apps/web/lib/edg/ops.ts` and `apps/web/lib/edg/find-replace.ts` already
 * established for the transcript column's batch edits (brief §3: "the same
 * pattern `onFixSpellingEverywhere`/'Fix spelling everywhere' in
 * `SegmentCard.tsx` already uses"). Every op these builders emit is one of the
 * existing `EdgOp` union members (`docs/CONTRACTS.md` §2, frozen) —
 * `EditWord`, `SetEmphasis`, `SetSegmentBounds` — batched across every
 * affected word or segment; nothing here proposes a new op.
 */
import { compareSeqKeys } from "@montaj/edg";
import type { EdgOp, Segment, Word } from "@montaj/edg";

import { type DisplayScript } from "@/components/editor/transcript/WordChip";

/** A client-minted op id. Callers pass `newId()` from `@montaj/edg`, same as `apps/web/lib/edg/ops.ts`. */
export type OpIdFactory = () => string;

/**
 * Unicode General Category `P` (every punctuation subclass: `Po`/`Ps`/`Pe`/
 * `Pi`/`Pf`/`Pc`/`Pd`) — deliberately not `\p{S}` (Symbol), so `$`/`%`-style
 * signs some transcripts carry survive "Remove Punctuation" untouched.
 */
const PUNCTUATION_PATTERN = /\p{P}/gu;

/**
 * Emoji glyphs: `Extended_Pictographic` (the Unicode property emoji-data.txt
 * itself recommends for "is this an emoji") plus `Regional_Indicator` (flag
 * pairs, which are Symbol-adjacent letters, not `Extended_Pictographic`) and
 * the two invisible joiners that stitch multi-codepoint sequences (family
 * emoji, skin-tone modifiers) together: U+FE0F (variation selector-16) and
 * U+200D (zero-width joiner), spelled as `\u` escapes rather than literal
 * invisible characters so the pattern stays reviewable in a diff. Stripping
 * the visible glyphs alone would leave an orphaned joiner behind.
 */
const VARIATION_SELECTOR_16 = "\u{FE0F}";
const ZERO_WIDTH_JOINER = "\u{200D}";
const EMOJI_PATTERN = new RegExp(
  `[\\p{Extended_Pictographic}\\p{Regional_Indicator}${VARIATION_SELECTOR_16}${ZERO_WIDTH_JOINER}]`,
  "gu",
);

/** Collapses whitespace a strip can leave behind, and trims the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every punctuation mark removed. Exported for its own unit tests. */
export function stripPunctuation(text: string): string {
  return collapseWhitespace(text.replace(PUNCTUATION_PATTERN, ""));
}

/** Every emoji glyph (and its joiners) removed. Exported for its own unit tests. */
export function stripEmojis(text: string): string {
  return collapseWhitespace(text.replace(EMOJI_PATTERN, ""));
}

/** What `script` currently displays for `word` — the same fallback `apps/web/lib/edg/find-replace.ts`'s `findMatches` reads. */
function currentWordText(word: Word, script: DisplayScript): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key (DisplayScript), not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return word.scripts?.[script] ?? word.t;
}

/**
 * One `EditWord` per live word whose `clean(currentText)` actually differs —
 * unaffected words are skipped so the batch never carries a no-op, and a word
 * that would clean to nothing (an emoji-only or punctuation-only token) is
 * left alone rather than emitted as an empty-text edit: turning a word
 * invisible is a `DeleteWord` decision neither brief asked for, so this stays
 * conservative and documents the skip instead of inventing that behaviour.
 */
function buildTextCleanupOps(
  words: readonly Word[],
  script: DisplayScript,
  clean: (text: string) => string,
  newOpId: OpIdFactory,
): EdgOp[] {
  const ops: EdgOp[] = [];
  for (const word of words) {
    if (word.deleted === true) continue;
    const current = currentWordText(word, script);
    const cleaned = clean(current);
    if (cleaned === "" || cleaned === current) continue;
    ops.push({ type: "EditWord", opId: newOpId(), wordId: word.wid, text: cleaned, script });
  }
  return ops;
}

/** "Remove Punctuation": strips `\p{P}` from every live word's `script` text. */
export function buildRemovePunctuationOps(
  words: readonly Word[],
  script: DisplayScript,
  newOpId: OpIdFactory,
): EdgOp[] {
  return buildTextCleanupOps(words, script, stripPunctuation, newOpId);
}

/** "Remove Emojis": strips emoji glyphs from every live word's `script` text. */
export function buildRemoveEmojiOps(
  words: readonly Word[],
  script: DisplayScript,
  newOpId: OpIdFactory,
): EdgOp[] {
  return buildTextCleanupOps(words, script, stripEmojis, newOpId);
}

/**
 * "Remove Emphasis": one `SetEmphasis{presetId: null}` per entry currently in
 * every segment's `emphasis` array — the array itself has no "clear all" op
 * (CONTRACTS §2), so clearing it is exactly as many ops as it has entries.
 */
export function buildRemoveEmphasisOps(
  segments: readonly Segment[],
  newOpId: OpIdFactory,
): EdgOp[] {
  const ops: EdgOp[] = [];
  for (const segment of segments) {
    for (const entry of segment.emphasis ?? []) {
      ops.push({
        type: "SetEmphasis",
        opId: newOpId(),
        segmentId: segment.id,
        wordId: entry.wordId,
        presetId: null,
      });
    }
  }
  return ops;
}

/**
 * "Remove Gaps in Captions": for every pair of consecutive, non-hidden
 * segments (by `seq` order) with dead air between them, extends the earlier
 * caption's `endMs` to the next one's `startMs` — one `SetSegmentBounds` per
 * gap closed. The later caption's `startMs` (and both segments' word ranges)
 * are left alone: it stays anchored to the word that actually starts it, so
 * captions never appear before their own audio does. `applySetSegmentBounds`
 * (`@montaj/edg`) never touches word timings, so this is a pure display-
 * window change, safe to batch independently of every other pair.
 */
export function buildRemoveGapsOps(segments: readonly Segment[], newOpId: OpIdFactory): EdgOp[] {
  const ordered = segments
    .filter((segment) => segment.hidden !== true)
    .slice()
    .sort((a, b) => compareSeqKeys(a.seq, b.seq));
  const ops: EdgOp[] = [];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index bounded by the loop's own `ordered.length` counter, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const current = ordered[i];
    const next = ordered[i + 1];
    if (current === undefined || next === undefined) continue;
    if (next.startMs > current.endMs) {
      ops.push({
        type: "SetSegmentBounds",
        opId: newOpId(),
        segmentId: current.id,
        startMs: current.startMs,
        endMs: next.startMs,
      });
    }
  }
  return ops;
}

/**
 * Clamps a requested Caption Delay offset so that, applied to every segment,
 * no segment would start before `0` or end after `durationMs`. Returns `0`
 * (no shift) when the segments already span the whole duration and there is
 * no room to move in either direction.
 */
export function clampCaptionDelayMs(
  segments: readonly Segment[],
  requestedOffsetMs: number,
  durationMs: number,
): number {
  if (segments.length === 0 || durationMs <= 0 || !Number.isFinite(requestedOffsetMs)) return 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const segment of segments) {
    if (segment.startMs < minStart) minStart = segment.startMs;
    if (segment.endMs > maxEnd) maxEnd = segment.endMs;
  }
  const lowerBound = -minStart;
  const upperBound = durationMs - maxEnd;
  if (lowerBound > upperBound) return 0;
  const clamped = Math.round(Math.min(upperBound, Math.max(lowerBound, requestedOffsetMs)));
  // `-minStart` is `-0` when the first segment already starts at 0, which
  // `Math.max`/`Math.round` can carry through to the result — normalise it so
  // callers (and `===` in tests) see a plain `0`, not a sign-bit surprise.
  return clamped === 0 ? 0 : clamped;
}

/**
 * "Caption Delay Control": one `SetSegmentBounds` per segment, `startMs`/
 * `endMs` both shifted by the same already-clamped `offsetMs` — the
 * "smallest existing op, batched" the brief asks for (item 4). Word-level
 * `s`/`e` are deliberately left untouched: they are ASR timestamps locked to
 * a transcript chunk's own bounds (`applySetWordTiming` rejects a retime that
 * crosses `chunkBounds`, `@montaj/edg`'s `ops/apply.ts`), so a document-wide
 * shift large enough to matter risks rejecting words near a chunk edge for no
 * benefit — caption *visibility* is governed entirely by `Segment.startMs`/
 * `endMs` (`visibleSegments`, `packages/render-core/src/frame/projection.ts`),
 * so shifting the segment envelope alone already moves every caption's
 * on-screen timing, which is what this control promises.
 */
export function buildCaptionDelayOps(
  segments: readonly Segment[],
  offsetMs: number,
  newOpId: OpIdFactory,
): EdgOp[] {
  if (offsetMs === 0) return [];
  return segments.map((segment) => ({
    type: "SetSegmentBounds" as const,
    opId: newOpId(),
    segmentId: segment.id,
    startMs: segment.startMs + offsetMs,
    endMs: segment.endMs + offsetMs,
  }));
}
