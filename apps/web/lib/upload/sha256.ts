/**
 * Incremental SHA-256 (FIPS 180-4), in constant memory.
 *
 * `SubtleCrypto.digest()` is the browser's real SHA-256 implementation and is
 * faster than anything written in JS — but it takes one buffer and gives one
 * answer, so hashing a 4 GB upload with it means holding the whole file in
 * memory at once. This class instead keeps only the running hash state (32
 * bytes) and one partial 64-byte block between calls to {@link update}, so
 * `hash-worker.ts` can feed it the file a slice at a time and never grow.
 *
 * Deliberately dependency-free: this is the whole algorithm, verified against
 * the FIPS 180-4 / RFC 6234 test vectors in `sha256.test.ts`.
 */

const BLOCK_BYTES = 64;
const WORDS_PER_BLOCK = 16;
const ROUNDS = 64;

// The first 32 bits of the fractional parts of the cube roots of the first 64
// primes (FIPS 180-4 §4.2.2).
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// The first 32 bits of the fractional parts of the square roots of the first
// 8 primes (FIPS 180-4 §5.3.3).
const INITIAL_H: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function add32(...values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum = (sum + value) >>> 0;
  return sum;
}

export class IncrementalSha256 {
  private h: number[] = [...INITIAL_H];
  private readonly w = new Array<number>(ROUNDS).fill(0);
  /** Bytes carried over from the last `update` that did not fill a block. */
  private pending = new Uint8Array(0);
  /** Total bytes fed in, tracked in two 32-bit halves (files exceed 2^32 bits). */
  private lengthLowBits = 0;
  private lengthHighBits = 0;
  private finalised = false;

  update(chunk: Uint8Array): void {
    if (this.finalised) throw new Error("IncrementalSha256: update() after digest()");
    this.addLength(chunk.byteLength);

    let data = chunk;
    if (this.pending.byteLength > 0) {
      const merged = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      merged.set(this.pending, 0);
      merged.set(chunk, this.pending.byteLength);
      data = merged;
    }

    let offset = 0;
    while (data.byteLength - offset >= BLOCK_BYTES) {
      this.compress(data, offset);
      offset += BLOCK_BYTES;
    }
    this.pending = offset < data.byteLength ? data.slice(offset) : new Uint8Array(0);
  }

  /** Pad, process the final block(s), and return the digest as lowercase hex. */
  digestHex(): string {
    if (!this.finalised) {
      const bitLenLow = (this.lengthLowBits << 3) >>> 0;
      // The three high bits shifted off `lengthLowBits` move into the high word.
      const carry = this.lengthLowBits >>> 29;
      const bitLenHigh = ((this.lengthHighBits << 3) | carry) >>> 0;

      const padLength =
        this.pending.byteLength < 56 ? 56 - this.pending.byteLength : 120 - this.pending.byteLength;
      const tail = new Uint8Array(this.pending.byteLength + padLength + 8);
      tail.set(this.pending, 0);
      tail[this.pending.byteLength] = 0x80;
      const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
      view.setUint32(tail.byteLength - 8, bitLenHigh, false);
      view.setUint32(tail.byteLength - 4, bitLenLow, false);

      for (let offset = 0; offset < tail.byteLength; offset += BLOCK_BYTES) {
        this.compress(tail, offset);
      }
      this.finalised = true;
    }

    return this.h.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  private addLength(byteLength: number): void {
    const next = this.lengthLowBits + byteLength;
    // Overflow carries a byte into the high word so files past 4 GiB still
    // hash correctly; `>>> 0` keeps the low word an unsigned 32-bit count.
    if (next > 0xffffffff) this.lengthHighBits = (this.lengthHighBits + 1) >>> 0;
    this.lengthLowBits = next >>> 0;
  }

  /** One 64-byte block, starting at `offset` in `data` (FIPS 180-4 §6.2.2). */
  private compress(data: Uint8Array, offset: number): void {
    const view = new DataView(data.buffer, data.byteOffset + offset, BLOCK_BYTES);
    const w = this.w;
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    for (let t = 0; t < WORDS_PER_BLOCK; t += 1) w[t] = view.getUint32(t * 4, false);
    for (let t = WORDS_PER_BLOCK; t < ROUNDS; t += 1) {
      const w15 = w[t - 15] ?? 0;
      const w2 = w[t - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      w[t] = add32(w[t - 16] ?? 0, s0, w[t - 7] ?? 0, s1);
    }

    let [a, b, c, d, e, f, g, hh] = this.h;
    a ??= 0;
    b ??= 0;
    c ??= 0;
    d ??= 0;
    e ??= 0;
    f ??= 0;
    g ??= 0;
    hh ??= 0;

    for (let t = 0; t < ROUNDS; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const t1 = add32(hh, s1, ch, K[t] ?? 0, w[t] ?? 0);
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = add32(s0, maj);

      hh = g;
      g = f;
      f = e;
      e = add32(d, t1);
      d = c;
      c = b;
      b = a;
      a = add32(t1, t2);
    }

    this.h = [
      add32(this.h[0] ?? 0, a),
      add32(this.h[1] ?? 0, b),
      add32(this.h[2] ?? 0, c),
      add32(this.h[3] ?? 0, d),
      add32(this.h[4] ?? 0, e),
      add32(this.h[5] ?? 0, f),
      add32(this.h[6] ?? 0, g),
      add32(this.h[7] ?? 0, hh),
    ];
  }
}

/** Convenience: hash one in-memory chunk in one call. */
export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new IncrementalSha256();
  hasher.update(bytes);
  return hasher.digestHex();
}
