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

export type LaneKind = "cuts" | "zoom" | "reframe" | "audio";

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
      return "zoom";
    case "reframe":
      return "reframe";
    case "sfx":
    case "music":
      return "audio";
    default:
      return undefined;
  }
}

const LANE_LABELS: Readonly<Record<LaneKind, string>> = {
  cuts: "Cuts",
  zoom: "Zoom",
  reframe: "Reframe",
  audio: "SFX & music",
};

/**
 * Builds the four read-only lanes from a document's pass items — B20 split
 * the original three-lane layout's merged "Zoom & reframe" row into separate
 * `zoom` and `reframe` lanes (brief §4: "zoom lane with keyframe markers and
 * scale curve mini-plot; reframe lane with crop-window markers" — two
 * different mini-plots need two rows). Passes are merged: a document can
 * have more than one `autocut`/`reframe` pass across its lifetime, and the
 * review surface (`PassesTab`) is what decides which of several `proposed`
 * items on the same range wins — this module only lays out what exists.
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
  const order: readonly LaneKind[] = ["cuts", "zoom", "reframe", "audio"];
  return order.map((kind) => ({
    kind,
    label: LANE_LABELS[kind],
    items: (byLane.get(kind) ?? []).sort((a, b) => a.startMs - b.startMs),
  }));
}

/**
 * How a lane item should be stroked (brief §4): `accepted` is dimmed and
 * struck through (the range really is going away), `proposed` is dashed
 * (still a suggestion), `rejected`/`modified` solid at full lane opacity —
 * a rejected item is already drawn at low alpha by its colour, and a
 * `modified` item is an open decision same as `proposed` but visually
 * distinguished by colour alone (its own amber) rather than a second dash
 * style, since two variables (colour + dash) already carry accepted vs.
 * proposed vs. rejected without a third encoding.
 */
export interface LaneItemStrokeStyle {
  readonly dash: readonly number[];
  readonly struckThrough: boolean;
  readonly alpha: number;
}

export function laneItemStrokeStyle(state: ItemState): LaneItemStrokeStyle {
  switch (state) {
    case "proposed":
      return { dash: [4, 3], struckThrough: false, alpha: 0.6 };
    case "accepted":
      return { dash: [], struckThrough: true, alpha: 0.4 };
    case "modified":
      return { dash: [], struckThrough: false, alpha: 0.6 };
    case "rejected":
      return { dash: [], struckThrough: false, alpha: 0.25 };
  }
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
