import type { RateLimitRule } from "../common/guards/index.js";

/**
 * A device flushing its offline queue can legitimately send a burst; 30
 * batches (up to 100 events each) an hour per device/user is generous headroom
 * over normal use while still bounding a runaway client.
 */
export const TELEMETRY_RATE_LIMITS: Record<
  "events" | "crash" | "diagnosticsBundle",
  RateLimitRule
> = {
  events: { name: "telemetry:events:user", by: "user", capacity: 30, refillPerSec: 30 / 3600 },
  /** Crashes should be rare; 10 an hour stops a crash-loop from flooding storage. */
  crash: { name: "telemetry:crash:user", by: "user", capacity: 10, refillPerSec: 10 / 3600 },
  /** A user builds a diagnostics bundle by hand; 5 an hour is generous. */
  diagnosticsBundle: {
    name: "telemetry:diagnostics-bundle:user",
    by: "user",
    capacity: 5,
    refillPerSec: 5 / 3600,
  },
};
