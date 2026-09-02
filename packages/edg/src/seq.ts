/**
 * Fractional ordering keys for `Segment.seq` (CONTRACTS §2, decision D28).
 *
 * A key is a base-62 *fraction* written without the leading `0.`: the digits
 * `0-9A-Za-z` are in ASCII order, so plain string comparison (`<`) is the same
 * as comparing the numbers they denote. Inserting between two neighbours only
 * writes the new row — siblings are never renumbered, which is the whole point
 * of the `edg_segments.seq` column.
 *
 * Canonical form: a non-empty key that never ends in the digit `0` (a trailing
 * zero denotes the same fraction as the key without it, and allowing both would
 * break "equal keys means equal position").
 */

/** Base-62 digits in ASCII (and therefore lexicographic) order. */
export const SEQ_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const SEQ_BASE = SEQ_ALPHABET.length;

/** Shape of a canonical fractional key. */
export const SEQ_KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

/** Thrown when a fractional key is malformed or a pair of keys is out of order. */
export class SeqError extends Error {
  override readonly name = "SeqError";
}

/** `true` when `value` is a canonical fractional key. */
export function isSeqKey(value: unknown): value is string {
  return typeof value === "string" && SEQ_KEY_PATTERN.test(value);
}

/** Compares two fractional keys; the result is `<0`, `0` or `>0` like a sort comparator. */
export function compareSeqKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertKey(value: string, label: string): void {
  if (!isSeqKey(value)) {
    throw new SeqError(
      `${label} must be a base-62 fractional key of [0-9A-Za-z] not ending in "0", got ${JSON.stringify(value)}`,
    );
  }
}

function digitAt(key: string, position: number): number {
  // Positions past the end read as 0, so "1" and "10" compare as equal fractions.
  return position < key.length ? SEQ_ALPHABET.indexOf(key.charAt(position)) : 0;
}

/**
 * The canonical key strictly between `a` and `b`, where `a` is `""` for "before
 * everything" and `b` is `undefined` for "after everything".
 */
function midpoint(a: string, b: string | undefined): string {
  if (b !== undefined) {
    if (a >= b) {
      throw new SeqError(
        `keys must be strictly increasing, got ${JSON.stringify(a)} >= ${JSON.stringify(b)}`,
      );
    }
    // Keep the shared prefix and recurse on the remainder, so "1A" / "1C" only
    // ever compares the digits that actually differ.
    let shared = 0;
    while (shared < b.length && digitAt(a, shared) === digitAt(b, shared)) shared += 1;
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
  }

  const low = a === "" ? 0 : digitAt(a, 0);
  const high = b === undefined ? SEQ_BASE : digitAt(b, 0);

  if (high - low > 1) {
    // There is room for a digit between the two, so one character is enough.
    const middle = Math.round(0.5 * (low + high));
    return SEQ_ALPHABET.charAt(middle);
  }
  if (b !== undefined && b.length > 1) {
    // `b` is longer than one digit, so its own first digit sits strictly
    // between the two (a shorter key is smaller than any key extending it).
    return b.slice(0, 1);
  }
  // The digits are adjacent: keep `a`'s first digit and subdivide what follows.
  return SEQ_ALPHABET.charAt(low) + midpoint(a.slice(1), undefined);
}

/**
 * Returns a fractional key strictly between `before` and `after`.
 *
 * - `seqBetween()` — the first key of an empty list.
 * - `seqBetween(last)` — append after `last`.
 * - `seqBetween(undefined, first)` — prepend before `first`.
 * - `seqBetween(a, b)` — insert between two neighbours; `a` must sort before `b`.
 *
 * Keys grow by at most one character per nested insertion, and insertion is
 * unbounded: there is always another key between any two distinct keys.
 */
export function seqBetween(before?: string | null, after?: string | null): string {
  const a = before ?? "";
  const b = after ?? undefined;
  if (a !== "") assertKey(a, "before");
  if (b !== undefined) assertKey(b, "after");
  return midpoint(a, b);
}

/**
 * `count` evenly spread keys, used to seed a fresh segment list.
 *
 * Computes each key directly from its rank rather than by repeatedly calling
 * `seqBetween(previous)`: appending after the previous key in a loop looks
 * like the obvious implementation, but `midpoint`'s "after everything" case
 * only ever has one digit of headroom above the previous key's leading
 * digit, so a long run of pure appends walks every digit position to `z`
 * before it can deepen — length grows *linearly* in `count`, not
 * logarithmically. A 54,000-word transcript's first segmentation (A15b
 * perf run) produced keys several hundred characters long this way, well
 * past the 128-character cursor `SegmentsQuery` accepts
 * (`apps/api/src/edg/edg.dto.ts`), which made every later page of that
 * transcript's segments 400 on `Request validation failed` and the editor
 * never finish loading. Evenly spacing `count` keys across the base-62
 * fraction space up front keeps every key's length to
 * `ceil(log62(count + 2)) + 1` characters — 4 characters for 54,000 items —
 * regardless of how the list was built.
 */
export function seqSequence(count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new SeqError(`count must be a non-negative integer, got ${String(count)}`);
  }
  if (count === 0) return [];

  // One digit of headroom beyond what distinguishes `count` values, so a key
  // is never adjacent to its neighbour — there is still room to insert
  // between any two, same as a hand-built sequence.
  let digits = 1;
  while (Math.pow(SEQ_BASE, digits) < count + 2) digits += 1;
  digits += 1;
  const scale = Math.pow(SEQ_BASE, digits);

  const keys: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const value = Math.floor((i * scale) / (count + 1));
    keys.push(encodeBase62(value, digits));
  }
  return keys;
}

/** `value` as a `digits`-wide base-62 string, trailing zeros trimmed to canonical form. */
function encodeBase62(value: number, digits: number): string {
  let remaining = value;
  const chars: string[] = [];
  for (let i = 0; i < digits; i += 1) {
    chars.unshift(SEQ_ALPHABET.charAt(remaining % SEQ_BASE));
    remaining = Math.floor(remaining / SEQ_BASE);
  }
  let key = chars.join("").replace(/0+$/, "");
  if (key === "") key = "1";
  return key;
}
