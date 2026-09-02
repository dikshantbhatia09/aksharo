/**
 * `@montaj/ass-exporter` — ASS/SSA sidecar writer plus the parity test harness.
 *
 * `toAss` maps a `StyleDoc` v2 catalogue and a projection to an ASS v4+
 * document (D33: `.ass` is a sidecar format only, never the burned-in path).
 * `capabilitiesOf` is the pre-gate, field-based capability estimate; the
 * authoritative `assRenderable`/`assExportable`/`requiresLayoutMetrics`/
 * `parityScore` flags are written only by the parity gate under `parity/`,
 * never by hand (see `packages/caption-styles/parity/results.json`).
 */

export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  readonly implementedBy: string;
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/ass-exporter",
  implementedBy: "A18a",
  implemented: true,
};

export { toAss, type ToAssResult } from "./to-ass.js";
export {
  type AssCanvas,
  type AssProjection,
  type AssSegment,
  type AssStyleCatalogue,
  type AssTranscript,
  type AssWord,
  type ToAssOptions,
} from "./types.js";
export {
  capabilitiesOf,
  EFFECT_ONLY_STYLE_IDS,
  type AssWarning,
  type AssWarningCode,
  type StyleAssCapability,
} from "./capabilities.js";
export {
  alignmentOf,
  buildStyleLine,
  fontSizePx,
  STYLE_FORMAT,
  type AssStyleLine,
} from "./style-map.js";
export { buildSegmentEvents, escapeAssText, wordsFor, type AssDialogueEvent } from "./events.js";
export {
  toAssAlpha,
  toAssColour,
  toAssColourNoAlpha,
  parseHexColour,
  type Rgba,
} from "./colour.js";
export { toAssTimestamp, toKaraokeCentis } from "./time.js";
