/**
 * The lot allocation algorithm (D32, `06-data-model.md` `credit_lots`), factored
 * out as pure functions over plain arrays so it can be unit-tested without a
 * database and reused identically by `reserve` (draw down) and `settle`/`release`
 * (give back).
 *
 * **Consumption order: soonest-expiring first, then FIFO.** A lot with an
 * `expiresAt` sorts before one with none, and ties (including two lots with no
 * expiry) break on `createdAt` then `id` — the id tiebreak matters only for two
 * lots minted in the same millisecond, which a monotonic ULID never produces
 * within one process but a clock skew across processes could.
 */

/** The subset of `credit_lots` the algorithm needs. */
export interface AllocatableLot {
  readonly id: string;
  readonly remainingTenths: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

/** One line of `credit_holds.lot_allocations` (Zod: `LotAllocationsSchema`). */
export interface LotAllocation {
  readonly lotId: string;
  readonly tenths: number;
}

/** Sort order used to pick which lot a reserve draws from next. */
export function compareLotsForConsumption(a: AllocatableLot, b: AllocatableLot): number {
  const aExpires = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bExpires = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aExpires !== bExpires) return aExpires - bExpires;
  const aCreated = a.createdAt.getTime();
  const bCreated = b.createdAt.getTime();
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface LotAllocationPlan {
  /** `[{lotId, tenths}]`, in draw order, summing to `amountTenths` when `fullyCovered`. */
  readonly allocations: readonly LotAllocation[];
  /** `false` when the lots on hand could not cover the full amount. */
  readonly fullyCovered: boolean;
  /** What is left unallocated when `!fullyCovered`; always 0 when `fullyCovered`. */
  readonly shortfallTenths: number;
}

/**
 * Draw `amountTenths` off `lots`, soonest-expiring first then FIFO, never taking
 * more than a lot's `remainingTenths`.
 *
 * Pure: it does not mutate `lots` or the caller's rows. The caller applies each
 * `{lotId, tenths}` as a `credit_lots.remaining_tenths -= tenths` inside its own
 * transaction, which is what makes the whole operation atomic.
 */
export function allocateLots(
  lots: readonly AllocatableLot[],
  amountTenths: number,
): LotAllocationPlan {
  if (!Number.isInteger(amountTenths) || amountTenths < 0) {
    throw new RangeError(`amountTenths must be a non-negative integer, received ${amountTenths}`);
  }

  const ordered = [...lots].sort(compareLotsForConsumption);
  const allocations: LotAllocation[] = [];
  let remaining = amountTenths;

  for (const lot of ordered) {
    if (remaining <= 0) break;
    if (lot.remainingTenths <= 0) continue;
    const take = Math.min(lot.remainingTenths, remaining);
    allocations.push({ lotId: lot.id, tenths: take });
    remaining -= take;
  }

  return { allocations, fullyCovered: remaining === 0, shortfallTenths: remaining };
}

/**
 * Give tenths back to the lots a hold drew from, in **reverse** draw order (the
 * lot drawn last is topped up first) so a partial give-back never returns more to
 * a lot than that lot ever gave up under this hold.
 *
 * Used by `settle` (actual < held: the unused difference) and `release` (the
 * whole hold). Pure, like {@link allocateLots}: the caller applies each
 * `{lotId, tenths}` as `credit_lots.remaining_tenths += tenths`.
 *
 * @throws RangeError if `tenths` exceeds the sum of `allocations` — the caller is
 * trying to return more than this hold ever took.
 */
export function giveBackLots(
  allocations: readonly LotAllocation[],
  tenths: number,
): readonly LotAllocation[] {
  if (!Number.isInteger(tenths) || tenths < 0) {
    throw new RangeError(`tenths must be a non-negative integer, received ${tenths}`);
  }
  const total = allocations.reduce((sum, a) => sum + a.tenths, 0);
  if (tenths > total) {
    throw new RangeError(
      `cannot give back ${tenths} tenths; the recorded allocations only took ${total}`,
    );
  }

  const result: LotAllocation[] = [];
  let remaining = tenths;
  for (const allocation of [...allocations].reverse()) {
    if (remaining <= 0) break;
    const give = Math.min(allocation.tenths, remaining);
    result.push({ lotId: allocation.lotId, tenths: give });
    remaining -= give;
  }
  return result;
}

/**
 * Split `amountTenths` across `allocations` proportionally to each entry's
 * share of the total, in order, with the rounding remainder going to the last
 * entry so the parts always sum to exactly `amountTenths`.
 *
 * Used by `reverse()` to portion a reversal across the lots a settled hold
 * originally drew from, so each portion can inherit **its own** lot's expiry
 * (D32: "a new lot inheriting the original lot's expiry") even when the hold
 * spanned more than one lot.
 */
export function proportionalSplit(
  allocations: readonly LotAllocation[],
  amountTenths: number,
): readonly LotAllocation[] {
  if (!Number.isInteger(amountTenths) || amountTenths < 0) {
    throw new RangeError(`amountTenths must be a non-negative integer, received ${amountTenths}`);
  }
  if (allocations.length === 0) return [];
  const total = allocations.reduce((sum, a) => sum + a.tenths, 0);
  if (total <= 0) return [];

  const result: LotAllocation[] = [];
  let remaining = amountTenths;
  allocations.forEach((allocation, index) => {
    const isLast = index === allocations.length - 1;
    const share = isLast ? remaining : Math.floor((allocation.tenths / total) * amountTenths);
    result.push({ lotId: allocation.lotId, tenths: share });
    remaining -= share;
  });
  return result;
}

/** Merge two allocation lists that may name the same lot more than once. */
export function mergeAllocations(
  a: readonly LotAllocation[],
  b: readonly LotAllocation[],
): readonly LotAllocation[] {
  const byLot = new Map<string, number>();
  for (const { lotId, tenths } of [...a, ...b]) {
    byLot.set(lotId, (byLot.get(lotId) ?? 0) + tenths);
  }
  return [...byLot.entries()].map(([lotId, tenths]) => ({ lotId, tenths }));
}
