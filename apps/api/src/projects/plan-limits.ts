import { DEFAULT_DERIVED_RETENTION_DAYS, RAW_RETENTION_DAYS } from "./projects.constants.js";

import type { EntitlementView } from "../workspaces/entitlement.service.js";

/**
 * The three plan numbers the ingest path needs, read off the entitlement.
 *
 * `EntitlementService` is A05's Free-plan stub until B02 computes it for real,
 * and that is deliberately fine here: the *shape* is settled, so when B02 starts
 * returning a paid plan's entitlement this file needs no edit at all. What it
 * must not do is guess — a missing or malformed key falls back to the Free plan's
 * value, never to "unlimited".
 */
export interface PlanMediaLimits {
  /** Largest single upload, in bytes (`entitlements.maxFileBytes`). */
  readonly maxFileBytes: number;
  /** Longest single item, in milliseconds. Enforced after probe (A07). */
  readonly maxDurationMs: number;
  /** How long derived objects and the project itself live (D47). */
  readonly retentionDays: number;
  /** Which plan the numbers came from, for the error body and the logs. */
  readonly planKey: string;
}

/** Free-plan values from `prisma/seed-data.ts`; the floor for every fallback. */
export const FREE_PLAN_MEDIA_LIMITS = {
  maxFileBytes: 500 * 1024 * 1024,
  maxDurationMs: 20 * 60 * 1000,
  retentionDays: DEFAULT_DERIVED_RETENTION_DAYS,
} as const;

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Read {@link PlanMediaLimits} off an entitlement document. */
export function mediaLimitsFor(entitlement: EntitlementView): PlanMediaLimits {
  const values = entitlement.entitlements;
  return {
    maxFileBytes: positiveInteger(values["maxFileBytes"], FREE_PLAN_MEDIA_LIMITS.maxFileBytes),
    maxDurationMs: positiveInteger(values["maxDurationMs"], FREE_PLAN_MEDIA_LIMITS.maxDurationMs),
    retentionDays: positiveInteger(values["retentionDays"], FREE_PLAN_MEDIA_LIMITS.retentionDays),
    planKey: entitlement.planKey,
  };
}

/**
 * What a clips run may process (2026-09-27), read off the entitlement.
 *
 * A clips product's ordinary input is a 30-minute to 3-hour video, and the
 * upload cap (`maxDurationMs`, Free 20 min) used to refuse every one of them. A
 * plan now limits the MINUTES PROCESSED per run: a longer source is cut down to
 * a window of it, never refused, up to the abuse ceiling.
 */
export interface PlanClipsLimits {
  /** The most of a source one run processes (`entitlements.clipsWindowMs`). */
  readonly clipsWindowMs: number;
  /** The longest source a run may look at at all (`entitlements.maxSourceDurationMs`). */
  readonly maxSourceDurationMs: number;
  /** Largest download, in bytes: the same cap an upload has. */
  readonly maxFileBytes: number;
  readonly planKey: string;
}

/** Free-plan clips values from `prisma/seed-data.ts`; the floor for every fallback. */
export const FREE_PLAN_CLIPS_LIMITS = {
  clipsWindowMs: 20 * 60 * 1000,
  maxSourceDurationMs: 12 * 60 * 60 * 1000,
} as const;

/**
 * Read {@link PlanClipsLimits} off an entitlement document.
 *
 * A missing `clipsWindowMs` falls back to the plan's own `maxDurationMs` before
 * Free's: the seeded windows are exactly those numbers, and an entitlement cached
 * from before the migration (60 s, `ENTITLEMENT_CACHE_TTL_SEC`) must not shrink a
 * Studio run to Free's 20 minutes. Neither fallback is ever "unlimited", and the
 * window never exceeds the ceiling.
 */
export function clipsLimitsFor(entitlement: EntitlementView): PlanClipsLimits {
  const values = entitlement.entitlements;
  const media = mediaLimitsFor(entitlement);
  const maxSourceDurationMs = positiveInteger(
    values["maxSourceDurationMs"],
    FREE_PLAN_CLIPS_LIMITS.maxSourceDurationMs,
  );
  const clipsWindowMs = positiveInteger(
    values["clipsWindowMs"],
    positiveInteger(values["maxDurationMs"], FREE_PLAN_CLIPS_LIMITS.clipsWindowMs),
  );
  return {
    clipsWindowMs: Math.min(clipsWindowMs, maxSourceDurationMs),
    maxSourceDurationMs,
    maxFileBytes: media.maxFileBytes,
    planKey: entitlement.planKey,
  };
}

/** `days` after `from`, as an instant. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** When the raw upload may be deleted: seven days from upload, per D47. */
export function rawPurgeAt(uploadedAt: Date): Date {
  return addDays(uploadedAt, RAW_RETENTION_DAYS);
}

/** When the derived objects may be deleted: the plan's retention from upload. */
export function derivedPurgeAt(uploadedAt: Date, limits: PlanMediaLimits): Date {
  return addDays(uploadedAt, limits.retentionDays);
}
