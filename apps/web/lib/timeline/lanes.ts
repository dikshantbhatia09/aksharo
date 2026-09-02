/**
 * The lanes API (brief §4): read-only rendering of `edg_pass_items` on the
 * timeline, grouped into rows B20 will later make interactive
 * (accept/reject). Kept as a small, stable shape — `LaneRow[]` — so B20 can
 * add its own affordances against `LaneItem` without this module changing.
 *
 * State colours are picked once here rather than duplicated at every draw
 * site; `laneStateColor` is the single source of truth a Canvas2D renderer
 * (or, later, a DOM one) reads.
 */
import type { ItemState, PassItem } from "@montaj/edg";

export type LaneKind = "cuts" | "zoom" | "audio";

export interface LaneItem {
  readonly itemId: string;
  readonly passId: string;
  readonly kind: PassItem["kind"];
  readonly startMs: number;
  readonly endMs: number;
  readonly state: ItemState;
  readonly reason?: string;
}

export interface LaneRow {
  readonly kind: LaneKind;
  readonly label: string;
  readonly items: readonly LaneItem[];
}

/** Which lane row a pass item's `kind` belongs on. */
function laneKindOf(itemKind: PassItem["kind"]): LaneKind | undefined {
  switch (itemKind) {
    case "cut":
      return "cuts";
    case "zoom":
    case "reframe":
      return "zoom";
    case "sfx":
    case "music":
      return "audio";
    default:
      return undefined;
  }
}

const LANE_LABELS: Readonly<Record<LaneKind, string>> = {
  cuts: "Cuts",
  zoom: "Zoom & reframe",
  audio: "SFX & music",
};

/**
 * Builds the three read-only lanes from a document's pass items. Passes are
 * merged: a document can have more than one `autocut` pass across its
 * lifetime, and the review surface (B20, out of scope here) is what decides
 * which of several `proposed` items on the same range wins — this module
 * only lays out what exists.
 */
export function buildLanes(items: readonly PassItem[]): readonly LaneRow[] {
  const byLane = new Map<LaneKind, LaneItem[]>();
  for (const item of items) {
    const kind = laneKindOf(item.kind);
    if (kind === undefined) continue;
    const row = byLane.get(kind) ?? [];
    row.push({
      itemId: item.itemId,
      passId: item.passId,
      kind: item.kind,
      startMs: item.startMs,
      endMs: item.endMs,
      state: item.state,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    });
    byLane.set(kind, row);
  }
  const order: readonly LaneKind[] = ["cuts", "zoom", "audio"];
  return order.map((kind) => ({
    kind,
    label: LANE_LABELS[kind],
    items: (byLane.get(kind) ?? []).sort((a, b) => a.startMs - b.startMs),
  }));
}

/** The state colour a lane item draws with — a closed mapping, never free text. */
export function laneStateColor(state: ItemState): string {
  switch (state) {
    case "proposed":
      return "#7c8ff0"; // indigo — awaiting review
    case "accepted":
      return "#4ade80"; // green
    case "modified":
      return "#facc15"; // amber
    case "rejected":
      return "#f87171"; // red, drawn hatched by the renderer
  }
}
