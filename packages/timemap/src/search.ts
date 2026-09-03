/**
 * The two binary searches every lookup goes through.
 *
 * Both take a **non-decreasing** array of keys and probe it `O(log n)` times —
 * `src/benchmark.test.ts` counts the probes through a `Proxy` to prove it. The
 * key arrays are built once by `buildTimeMap`, so a lookup allocates nothing.
 */

/** Index of the first key `>= value`, or `keys.length` when every key is smaller. */
export function lowerBound(keys: readonly number[], value: number): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if ((keys[mid] as number) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Index of the last key `<= value`, or `-1` when every key is larger. */
export function upperBound(keys: readonly number[], value: number): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if ((keys[mid] as number) <= value) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
