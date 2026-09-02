import type { RateLimitRule } from "../common/guards/index.js";

export const BATCH_ERRORS = {
  notFound: "batch/not_found",
  empty: "batch/empty",
} as const;

/** Same ceiling as a single `POST /projects/batch` (A06's `PROJECT_BATCH_MAX`). */
export const BATCH_MAX_PROJECTS = 50;

export const BATCH_RATE_LIMITS = {
  create: {
    name: "batch:create:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 3600,
  },
  apply: {
    name: "batch:apply:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;
