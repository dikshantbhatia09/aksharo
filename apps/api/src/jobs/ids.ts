import { monotonicFactory } from "ulid";

/**
 * Monotonic ULIDs for anything whose id is also its sort key.
 *
 * `ulid()` randomises the low 80 bits on every call, so two ids minted in the
 * same millisecond sort in an arbitrary order. Jobs and job events are listed
 * *and paginated* by id, so an arbitrary order there is a page that skips a row —
 * `monotonicFactory` increments the random component instead, which keeps ids
 * strictly increasing within a millisecond in this process and still time-ordered
 * across processes.
 */
export const jobUlid = monotonicFactory();
