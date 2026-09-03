/**
 * Resolves accepted zoom/reframe pass items' keyframe curves into the
 * `RenderManifest`'s `timemap.keyframes` tracks (CONTRACTS §2, B20b —
 * `manifest-builder.ts`'s `keyframeTracks` input was left unwired pending
 * this read path, see its own doc comment).
 *
 * A curve rides on the item as either inline base64 (`payload.keyframes`,
 * <= 64 KiB) or a derived-storage reference (`payload.keyframesRef` /
 * `PassItem.keyframesRef` — B19b's `passes-completion.handler.ts` sets both
 * to the same value on the ref path); this module reads whichever is
 * present and never re-uploads or mutates anything — a pure read helper, in
 * keeping with this file's place in the "read helpers only" boundary of
 * `apps/api/src/passes/**`.
 */
import type { ObjectStore } from "../common/storage/index.js";

import type { KeyframeTrack } from "@montaj/render-manifest";

/** The subset of `PassItem` this resolver needs (structural, to avoid an import cycle). */
export interface KeyframeCarryingItem {
  readonly itemId: string;
  readonly kind: string;
  readonly state: string;
  readonly startMs: number;
  readonly payload: Record<string, unknown>;
  readonly keyframesRef?: string;
}

const KEYFRAME_KINDS = new Set(["zoom", "reframe"]);

function refOf(item: KeyframeCarryingItem): string | undefined {
  if (typeof item.payload["keyframesRef"] === "string") return item.payload["keyframesRef"];
  return item.keyframesRef;
}

function inlineOf(item: KeyframeCarryingItem): string | undefined {
  return typeof item.payload["keyframes"] === "string" ? item.payload["keyframes"] : undefined;
}

/**
 * Builds the manifest's `keyframeTracks` from every *accepted* zoom/reframe
 * item among `items` — proposed and rejected items never render. Items with
 * neither an inline curve nor a ref are skipped (a malformed item should
 * never block an export; `passes-completion.handler.ts`'s zod schema already
 * guarantees exactly one is set on write, so this is defensive only).
 */
export async function resolveKeyframeTracks(
  items: readonly KeyframeCarryingItem[],
  store: Pick<ObjectStore, "get">,
): Promise<KeyframeTrack[]> {
  const accepted = items.filter(
    (item) => KEYFRAME_KINDS.has(item.kind) && item.state === "accepted",
  );

  const tracks = await Promise.all(
    accepted.map(async (item): Promise<KeyframeTrack | undefined> => {
      const inline = inlineOf(item);
      if (inline !== undefined) {
        return {
          itemId: item.itemId,
          kind: item.kind as "zoom" | "reframe",
          itemStartMs: item.startMs,
          packed: inline,
        };
      }
      const ref = refOf(item);
      if (ref === undefined) return undefined;
      const bytes = await store.get(ref);
      return {
        itemId: item.itemId,
        kind: item.kind as "zoom" | "reframe",
        itemStartMs: item.startMs,
        packed: bytes.toString("base64"),
      };
    }),
  );

  return tracks.filter((track): track is KeyframeTrack => track !== undefined);
}
