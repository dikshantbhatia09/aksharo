/**
 * Apply accepted `title` items (D09 brief §Scope 1; orchestrator addendum 2026-09-03 after D06:
 * there is no `text_fx` kind — every text-fx item rides `title` with the additive
 * `motionPreset`/`intent`/`anchorWordIds`/`layoutHint` fields, CONTRACTS §2 amendment) as
 * instances of the title MOGRT this WP added to C06b's generator
 * (`mogrt/generate.ts#generateTitleMogrtDefinition`, `mogrt/title-params.ts`), or — when a
 * preset this table can't express at all — an overlay clip instead.
 *
 * All param resolution (which preset maps to which `PositionY`/`HighlightStart`/`HighlightEnd`
 * values) happens once in `@montaj/shared-apply`'s `motionPresets.ts`/`planBuilder.ts`; this
 * module only turns the resulting `TitleParamOp`s into host calls.
 */
import { buildApplyPlan } from "@montaj/shared-apply";
import type { ApplyPlanItem, TitleParamOp } from "@montaj/shared-apply";

import type { PremiereHost } from "../host/premiere.js";

const msToFrames = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

export interface ApplyTitlesOptions {
  readonly projectId: string;
  readonly items: readonly ApplyPlanItem[];
  /** Local path to this WP's title `.mogrt` (built by `mogrt/build-placeholder.ts`'s sibling for
   * the title definition, or the real AE-authored file post-Gate-C). */
  readonly titleMogrtPath: string;
  readonly trackIndex: number;
  readonly fps: number;
  /** Local path to a pre-rendered overlay clip for a given `itemId`, used only when the plan
   * marks `requiresOverlayFallback` (no preset this table publishes today triggers this; see
   * `@montaj/shared-apply`'s `motionPresets.ts` doc comment). */
  readonly overlayMediaPaths?: ReadonlyMap<string, string>;
}

export type TitlePlacementVia = "mogrt" | "overlay";

export interface PlacedTitle {
  readonly itemId: string;
  readonly trackItemId: string;
  readonly via: TitlePlacementVia;
}

export interface SkippedTitle {
  readonly itemId: string;
  readonly reason: "overlay-media-not-rendered";
}

export interface ApplyTitlesResult {
  readonly placed: readonly PlacedTitle[];
  readonly skipped: readonly SkippedTitle[];
}

export async function applyAcceptedTitles(
  host: PremiereHost,
  options: ApplyTitlesOptions,
): Promise<ApplyTitlesResult> {
  const plan = buildApplyPlan(options.items);
  const titleOps = plan.ops.filter((op): op is TitleParamOp => op.op === "title");

  const placed: PlacedTitle[] = [];
  const skipped: SkippedTitle[] = [];

  for (const op of titleOps) {
    const startFrames = msToFrames(op.startMs, options.fps);
    const durationFrames = msToFrames(op.endMs - op.startMs, options.fps);

    if (op.requiresOverlayFallback) {
      const overlayPath = options.overlayMediaPaths?.get(op.itemId);
      if (!overlayPath) {
        skipped.push({ itemId: op.itemId, reason: "overlay-media-not-rendered" });
        continue;
      }
      const bin = await host.importMediaToBin({ sourcePath: overlayPath });
      const { trackItemId } = await host.placeOnTrack({
        itemId: bin.itemId,
        trackIndex: options.trackIndex,
        startFrames,
        durationFrames,
      });
      await host.setItemMetadata(trackItemId, {
        aksharo: { projectId: options.projectId, itemId: op.itemId, rev: 0 },
      });
      placed.push({ itemId: op.itemId, trackItemId, via: "overlay" });
      continue;
    }

    const { itemId: mogrtItemId } = await host.insertMogrt({
      mogrtPath: options.titleMogrtPath,
      trackIndex: options.trackIndex,
      startFrames,
      durationFrames,
    });
    await host.setMogrtParams(mogrtItemId, op.params);
    await host.setItemMetadata(mogrtItemId, {
      aksharo: { projectId: options.projectId, itemId: op.itemId, rev: 0 },
    });
    placed.push({ itemId: op.itemId, trackItemId: mogrtItemId, via: "mogrt" });
  }

  return { placed, skipped };
}
