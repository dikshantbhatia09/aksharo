/**
 * `@montaj/timemap` — one source-time ↔ output-time mapping (decision D30).
 *
 * Accepted cuts remove source ranges, speed edits retime them and holds insert
 * freeze frames; this package turns that list into an immutable structure with
 * `O(log n)` lookups in both directions, plus the helpers that move caption
 * segments, word timings and keyframe curves onto the output clock.
 *
 * Consumed by the browser exporter, the cloud renderer, the timeline UI and the
 * NLE plugins, so it is pure, does no I/O and imports nothing Node-only.
 *
 * See `README.md` for the boundary rules and `docs/CONTRACTS.md` §2 for the
 * `Segment`, `Word` and `PassItem` shapes it reads.
 */
export {
  type CutEdit,
  cutEdit,
  type Edit,
  type EditKind,
  type HoldEdit,
  holdEdit,
  insideCuts,
  type NormalisedEdits,
  normaliseEdits,
  type NormaliseOptions,
  type SpeedEdit,
  speedEdit,
} from "./edits.js";
export { isTimeMapError, TimeMapError, type TimeMapErrorCode } from "./errors.js";
export { frameAt, frameDurationMs, type SnapMode, snapToFrame } from "./frames.js";
export { type Keyframe, type MapKeyframesOptions } from "./keyframes.js";
export {
  type FromAcceptedItemsOptions,
  cutsFromItems,
  fromAcceptedItems,
  type PassItemTimes,
} from "./pass-items.js";
export type { OutputLocation, OutputRange, SourceLocation, TimeQuery } from "./query.js";
export {
  type MappedSegment,
  type MappedWord,
  type SegmentTimes,
  type WordTimes,
} from "./segments.js";
export { parseTimeMap, stringifyTimeMap } from "./serialise.js";
export type { SpanKind, TimeSpan } from "./spans.js";
export {
  buildTimeMap,
  type SerialisedTimeMap,
  TIMEMAP_FORMAT_VERSION,
  type TimeMap,
  type TimeMapOptions,
} from "./timemap.js";
