/**
 * Identifier helpers: ULIDs (CONTRACTS §0 — "IDs: ULID strings") and the stable
 * word ids `"<chunkIdx>:<n>"` from decision D28.
 *
 * The ULID factory is implemented here rather than pulled from npm because the
 * whole surface is 60 lines, the monotonic behaviour has to be deterministic
 * under test, and every id in the platform flows through it.
 */

/** Crockford base-32 digits: no `I`, `L`, `O` or `U`. */
export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 10 timestamp characters + 16 randomness characters; the first digit caps the 48-bit time. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const ULID_MAX_TIME = 281_474_976_710_655; // 2 ** 48 - 1

/** Word ids are `"<chunkIdx>:<n>"`, allocated once and never reused (D28). */
export const WORD_ID_PATTERN = /^\d+:\d+$/;

/**
 * A stable word id, `"<chunkIdx>:<n>"`. Frozen in CONTRACTS §2; the template
 * literal type is what makes a plain `string` unassignable by accident.
 */
export type WordId = `${number}:${number}`;

/** Thrown when an id is malformed or out of range. */
export class IdError extends Error {
  override readonly name = "IdError";
}

/** `true` when `value` is a syntactically valid ULID. */
export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_PATTERN.test(value);
}

/** Encodes a millisecond timestamp as the 10-character ULID time prefix. */
export function encodeUlidTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > ULID_MAX_TIME) {
    throw new IdError(
      `ULID time must be an integer in [0, ${ULID_MAX_TIME}], got ${String(timeMs)}`,
    );
  }
  let remaining = timeMs;
  let out = "";
  for (let i = 0; i < ULID_TIME_LENGTH; i += 1) {
    out = ULID_ALPHABET.charAt(remaining % 32) + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** Reads the millisecond timestamp back out of a ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new IdError(`not a ULID: ${JSON.stringify(id)}`);
  let time = 0;
  for (let i = 0; i < ULID_TIME_LENGTH; i += 1) {
    time = time * 32 + ULID_ALPHABET.indexOf(id.charAt(i));
  }
  return time;
}

/** Injection points that make the factory deterministic in tests. */
export interface UlidFactoryOptions {
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Returns `count` random base-32 digit values in `[0, 32)`; defaults to `crypto`. */
  randomDigits?: (count: number) => number[];
}

function cryptoRandomDigits(count: number): number[] {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is a multiple of 32, so the low five bits stay uniform.
  return Array.from(bytes, (byte) => byte % 32);
}

/**
 * Creates a monotonic ULID factory: ids generated inside the same millisecond
 * increment the random component instead of repeating it, so ids from one
 * process always sort in creation order.
 */
export function createUlidFactory(options: UlidFactoryOptions = {}): () => string {
  const now = options.now ?? (() => Date.now());
  const randomDigits = options.randomDigits ?? cryptoRandomDigits;
  let lastTime = -1;
  let lastRandom: number[] = [];

  return function ulid(): string {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      lastRandom = randomDigits(ULID_RANDOM_LENGTH);
      if (lastRandom.length !== ULID_RANDOM_LENGTH) {
        throw new IdError(`randomDigits must return ${ULID_RANDOM_LENGTH} values`);
      }
    } else {
      // Same (or a backwards) millisecond: add one to the 80-bit random field.
      let carry = 1;
      for (let i = ULID_RANDOM_LENGTH - 1; i >= 0 && carry === 1; i -= 1) {
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        const next = (lastRandom[i] ?? 0) + carry;
        // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
        lastRandom[i] = next % 32;
        carry = next >= 32 ? 1 : 0;
      }
      if (carry === 1) throw new IdError("ULID randomness exhausted within a single millisecond");
    }
    let out = encodeUlidTime(lastTime);
    for (const digit of lastRandom) out += ULID_ALPHABET.charAt(digit % 32);
    return out;
  };
}

/** The process-wide monotonic ULID factory. */
export const newId: () => string = createUlidFactory();

/** Builds the stable word id for word `n` of chunk `chunkIdx`. */
export function makeWordId(chunkIdx: number, n: number): WordId {
  if (!Number.isInteger(chunkIdx) || chunkIdx < 0) {
    throw new IdError(`chunkIdx must be a non-negative integer, got ${String(chunkIdx)}`);
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new IdError(`n must be a non-negative integer, got ${String(n)}`);
  }
  return `${chunkIdx}:${n}`;
}

/** `true` when `value` is a syntactically valid word id. */
export function isWordId(value: unknown): value is WordId {
  return typeof value === "string" && WORD_ID_PATTERN.test(value);
}

/** Splits a word id back into its chunk index and per-chunk sequence number. */
export function parseWordId(wordId: string): { chunkIdx: number; n: number } {
  if (!isWordId(wordId)) throw new IdError(`not a word id: ${JSON.stringify(wordId)}`);
  const [chunk, n] = wordId.split(":");
  return { chunkIdx: Number(chunk), n: Number(n) };
}
