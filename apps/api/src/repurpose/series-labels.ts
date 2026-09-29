import { MAX_OVERLAYS, newId, stableOverlayId } from "@montaj/edg";
import type { EdgOp, HookTitleOverlay, Overlay, PassItem } from "@montaj/edg/schemas";
import { fromAcceptedItems } from "@montaj/timemap";

/**
 * A series' labels on one clip shape (2026-10-03): "Part N of M" over the
 * first seconds of the video as it plays, and - on every part but the last -
 * "Part N+1 next" over its last seconds, before a brand end card if it has one.
 * Both are hook titles (`EdgHot.overlays`), so every surface draws them the way
 * it draws Autopilot's hook: placed off faces and captions by render-core.
 *
 * **What is replaced, and what is kept.** Autopilot's own hook title (the shape
 * variant's id, `clip-finishing.ts`) gives way to the part label and is
 * recorded, so "Remove series labels" puts it back; the label keeps its look (a
 * brand kit's card and typeface). A hook title the person wrote themselves is
 * never touched: a label that would overlap one is left off instead.
 *
 * Pure: the document's overlays and pass items in, the ops out.
 */

/** How long each label is up. */
export const SERIES_LABEL_MS = 2_000;
/** Kept between the part label and the next-part label, so they never run together. */
const LABEL_GAP_MS = 500;

export function partText(part: number, parts: number): string {
  return `Part ${String(part)} of ${String(parts)}`;
}

export function nextText(part: number): string {
  return `Part ${String(part + 1)} next`;
}

/** The labels' ids on a shape: the same on every ask, so a label is set, never doubled. */
export function seriesLabelIds(variantId: string): {
  readonly part: string;
  readonly next: string;
} {
  return {
    part: stableOverlayId(`${variantId}:series-part`),
    next: stableOverlayId(`${variantId}:series-next`),
  };
}

interface Window {
  readonly startMs: number;
  readonly endMs: number;
}

function overlaps(a: Window, b: Window): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export interface SeriesLabelInput {
  /** The clip shape's variant: Autopilot's hook title carries its id. */
  readonly variantId: string;
  /** 1-based. */
  readonly part: number;
  readonly parts: number;
  readonly overlays: readonly Overlay[];
  /** Every pass item of the document: the accepted cuts decide what plays. */
  readonly items: readonly PassItem[];
  /** The shape's own media length (the document's primary). */
  readonly durationMs: number;
}

export interface SeriesLabelPlan {
  readonly ops: EdgOp[];
  /** Autopilot's hook title the part label took the place of; null when none. */
  readonly replaced: HookTitleOverlay | null;
  /** The labels this writes, by id, in the order of `ops`. */
  readonly added: string[];
}

/** See the module comment. Nothing to do (no room, no media) is an empty plan. */
export function planSeriesLabels(input: SeriesLabelInput): SeriesLabelPlan {
  const empty: SeriesLabelPlan = { ops: [], replaced: null, added: [] };
  const { variantId, part, parts, overlays, durationMs } = input;
  if (durationMs <= 0 || part < 1 || part > parts) return empty;
  const timeMap = fromAcceptedItems(input.items, { sourceDurationMs: durationMs });
  const outputEnd = timeMap.outputDurationMs;
  if (outputEnd <= 0) return empty;
  /** Output ms (the video as it plays) to the source clock the document keeps. */
  const sourceWindow = (fromMs: number, toMs: number): Window | undefined => {
    const startMs = Math.max(0, Math.round(timeMap.toSource(fromMs)));
    const endMs = Math.min(durationMs, Math.round(timeMap.toSource(toMs)));
    return endMs > startMs ? { startMs, endMs } : undefined;
  };

  const ids = seriesLabelIds(variantId);
  const autopilot = overlays.find(
    (overlay): overlay is HookTitleOverlay =>
      overlay.kind === "hook-title" && overlay.id === variantId,
  );
  const own = overlays.filter(
    (overlay) =>
      overlay.kind === "hook-title" &&
      overlay.id !== variantId &&
      overlay.id !== ids.part &&
      overlay.id !== ids.next,
  );
  const clear = (window: Window | undefined): window is Window =>
    window !== undefined && !own.some((overlay) => overlaps(overlay, window));

  const partEnd = Math.min(SERIES_LABEL_MS, outputEnd);
  let partWindow = sourceWindow(0, partEnd);
  let nextWindow: Window | undefined;
  if (part < parts) {
    // Before an end card: the card is the brand's, and covers the frame.
    const card = overlays.find((overlay) => overlay.kind === "end-card");
    const cardAt = card === undefined ? null : timeMap.toOutput(card.startMs);
    const end = cardAt === null ? outputEnd : Math.min(outputEnd, cardAt);
    const from = end - SERIES_LABEL_MS;
    if (from >= partEnd + LABEL_GAP_MS) nextWindow = sourceWindow(from, end);
  }
  if (!clear(partWindow)) partWindow = undefined;
  if (!clear(nextWindow)) nextWindow = undefined;

  // A document carries at most MAX_OVERLAYS: the next-part label gives way first.
  const present = new Set(overlays.map((overlay) => overlay.id));
  const count = (): number =>
    overlays.length -
    (partWindow !== undefined && autopilot !== undefined ? 1 : 0) +
    (partWindow !== undefined && !present.has(ids.part) ? 1 : 0) +
    (nextWindow !== undefined && !present.has(ids.next) ? 1 : 0);
  if (count() > MAX_OVERLAYS) nextWindow = undefined;
  if (count() > MAX_OVERLAYS) partWindow = undefined;

  const appearance = autopilot?.appearance;
  const ops: EdgOp[] = [];
  const added: string[] = [];
  let replaced: HookTitleOverlay | null = null;
  if (partWindow !== undefined) {
    if (autopilot !== undefined) {
      ops.push({ opId: newId(), type: "RemoveOverlay", overlayId: autopilot.id });
      replaced = autopilot;
    }
    ops.push({
      opId: newId(),
      type: "SetOverlay",
      overlay: {
        id: ids.part,
        kind: "hook-title",
        text: partText(part, parts),
        ...partWindow,
        ...(appearance === undefined ? {} : { appearance }),
      },
    });
    added.push(ids.part);
  }
  if (nextWindow !== undefined) {
    ops.push({
      opId: newId(),
      type: "SetOverlay",
      overlay: {
        id: ids.next,
        kind: "hook-title",
        text: nextText(part),
        ...nextWindow,
        ...(appearance === undefined ? {} : { appearance }),
      },
    });
    added.push(ids.next);
  }
  return { ops, replaced, added };
}

/**
 * "Remove series labels" on one shape: its labels come off, and Autopilot's
 * hook title goes back - unless the person has since put a title of their own
 * over its seconds, which is kept.
 */
export function planLabelRemoval(input: {
  readonly added: readonly string[];
  readonly replaced: HookTitleOverlay | null;
  readonly overlays: readonly Overlay[];
}): EdgOp[] {
  const present = new Set(input.overlays.map((overlay) => overlay.id));
  const ops: EdgOp[] = input.added
    .filter((id) => present.has(id))
    .map((overlayId) => ({ opId: newId(), type: "RemoveOverlay" as const, overlayId }));
  const replaced = input.replaced;
  if (replaced !== null && !present.has(replaced.id)) {
    const own = input.overlays.filter(
      (overlay) => overlay.kind === "hook-title" && !input.added.includes(overlay.id),
    );
    if (!own.some((overlay) => overlaps(overlay, replaced))) {
      ops.push({ opId: newId(), type: "SetOverlay", overlay: replaced });
    }
  }
  return ops;
}

/** A hook-title overlay read back from a stored series record, or null. */
export function hookOverlayOf(value: unknown): HookTitleOverlay | null {
  if (typeof value !== "object" || value === null) return null;
  const overlay = value as Partial<HookTitleOverlay>;
  return overlay.kind === "hook-title" &&
    typeof overlay.id === "string" &&
    typeof overlay.text === "string" &&
    typeof overlay.startMs === "number" &&
    typeof overlay.endMs === "number"
    ? (overlay as HookTitleOverlay)
    : null;
}
