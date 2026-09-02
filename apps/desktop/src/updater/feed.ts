/**
 * electron-updater feed selection and staged-rollout math (brief §4). Pure
 * logic only — wiring `autoUpdater.setFeedURL` / `checkForUpdates` lives in
 * `src/updater/index.ts`, which needs a running Electron app to test.
 */
import { createHash } from "node:crypto";

import { BRAND } from "@montaj/config/brand";

export type UpdateChannel = "alpha" | "beta" | "stable";

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["alpha", "beta", "stable"];

export function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/** C00's release feed layout: `releases/<channel>/` under the release host. */
export function feedUrl(channel: UpdateChannel): string {
  return `https://releases.${BRAND.domain}/releases/${channel}/`;
}

export interface RolloutFeedMeta {
  /** Staged rollout percentage (0-100) published alongside the feed by C00. */
  stagedRolloutPercentage?: number;
}

/**
 * Deterministic staged-rollout gate: the same `installId` always lands on the
 * same side of the threshold for a given release, so a device does not flap
 * between "eligible" and "not eligible" across `checkForUpdates` polls.
 */
export function isEligibleForRollout(installId: string, meta: RolloutFeedMeta): boolean {
  const pct = meta.stagedRolloutPercentage;
  if (pct === undefined) return true;
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  const digest = createHash("sha256").update(installId).digest();
  // First 4 bytes as an unsigned int, mapped to [0, 100).
  const bucket = (digest.readUInt32BE(0) / 0xffffffff) * 100;
  return bucket < pct;
}
