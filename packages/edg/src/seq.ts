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
 */
export function seqSequence(count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new SeqError(`count must be a non-negative integer, got ${String(count)}`);
  }
  const keys: string[] = [];
  let previous: string | undefined;
  for (let i = 0; i < count; i += 1) {
    previous = seqBetween(previous);
    keys.push(previous);
  }
  return keys;
}
