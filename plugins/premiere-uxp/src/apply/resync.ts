/**
 * Host-id map + re-sync (C06 brief §Scope 7): every item created by an apply mode carries
 * `{aksharo:{projectId, segmentId|itemId, rev}}` in its marker guid (`PremiereHost#setItemMetadata`);
 * a re-sync op fetches the current EDG revision and updates or removes only *changed* items —
 * an item whose `segmentId` no longer exists at the new revision is removed; every other
 * Aksharo item is left untouched (this WP does not re-run styling/placement on every re-sync,
 * only prunes stale items and reports which ones changed for the caller to decide what to
 * re-apply).
 */
import type { EdgRevisionSnapshot } from "./types.js";
import type { AksharoTrackedItem, PremiereHost } from "../host/premiere.js";

export interface ResyncResult {
  readonly removed: readonly string[];
  readonly stale: readonly string[];
  readonly upToDate: readonly string[];
}

/**
 * Diffs every Aksharo-tagged track item against `snapshot`: items for the same `projectId`
 * whose `segmentId` no longer appears in `snapshot.liveSegmentIds` are removed via
 * `host.removeItem`; items whose `rev` is older than `snapshot.revision` are reported `stale`
 * (their segment still exists, but the item may need re-applying — left to the caller so this
 * op never re-runs styling on the user's behalf); everything else is `upToDate`.
 */
export async function resync(
  host: PremiereHost,
  snapshot: EdgRevisionSnapshot,
): Promise<ResyncResult> {
  const tracked: readonly AksharoTrackedItem[] = await host.listAksharoItems();
  const liveIds = new Set(snapshot.liveSegmentIds);

  const removed: string[] = [];
  const stale: string[] = [];
  const upToDate: string[] = [];

  for (const { trackItemId, metadata } of tracked) {
    const { projectId, segmentId, rev } = metadata.aksharo;
    if (projectId !== snapshot.projectId) continue; // not this project's item

    if (segmentId !== undefined && !liveIds.has(segmentId)) {
      await host.removeItem(trackItemId);
      removed.push(trackItemId);
      continue;
    }

    if (rev < snapshot.revision) {
      stale.push(trackItemId);
    } else {
      upToDate.push(trackItemId);
    }
  }

  return { removed, stale, upToDate };
}
