import { notFound } from "next/navigation";

import {
  ALL_LAUNCH_SURFACES,
  DEFAULT_SURFACE_AVAILABILITY,
  LAUNCH_SURFACE_FLAGS,
  surfaceEnabled,
  type LaunchSurface,
  type LaunchSurfaceFlagKey,
} from "@montaj/config";

import { parseFlags } from "@/lib/flags";

export {
  ALL_LAUNCH_SURFACES,
  DEFAULT_SURFACE_AVAILABILITY,
  LAUNCH_SURFACE_FLAGS,
  surfaceEnabled,
  type LaunchSurface,
  type LaunchSurfaceFlagKey,
};

/**
 * Reads feature flags from `process.env.FEATURE_FLAGS_JSON` on the server.
 * Safe to evaluate across Node, Next.js server components, edge middleware,
 * and Vitest test harnesses.
 */
export function getServerFlags(): Record<string, boolean> {
  const raw =
    typeof process !== "undefined" && process.env
      ? (process.env["FEATURE_FLAGS_JSON"] ?? null)
      : null;
  return parseFlags(raw);
}

/**
 * Returns whether a launch surface is enabled on the server for the current process.
 */
export function isServerSurfaceEnabled(surface: LaunchSurface): boolean {
  return surfaceEnabled(surface, getServerFlags());
}

/**
 * Server-side direct-route guard (RLS-006).
 *
 * Calls Next.js `notFound()` if the given launch surface is not enabled in this release.
 * Prevents client-only bypasses and crawler/OG metadata leakage.
 */
export function assertServerSurfaceEnabled(surface: LaunchSurface): void {
  if (!isServerSurfaceEnabled(surface)) {
    notFound();
  }
}
