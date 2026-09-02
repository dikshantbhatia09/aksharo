/**
 * `edg/init` — how a finished transcript becomes an editing document (A11).
 *
 * A12 owns everything else under `src/edg/`; this folder is the one seam it left
 * open, and it holds no state and no Nest provider — just the decisions that turn
 * transcript facts into the `EdgInitInput` that `EdgService.initialise` takes.
 */
export {
  aspectOf,
  budgetsForMeta,
  CAPTION_RENDER_CONTEXT,
  canvasAspectFor,
  CANVAS_SIZES,
  fitCapFor,
  resolveBudgets,
  systemStyle,
} from "./caption-budgets.js";
export type {
  CaptionBudgets,
  CaptionRenderContext,
  ResolveBudgetsInput,
} from "./caption-budgets.js";
export { captionRenderContext, resetCaptionRenderContext } from "./caption-render-context.js";
export {
  CAPTION_BOUNDS,
  DEFAULT_STYLE_REF,
  edgInitInputFor,
  segmenterParamsFor,
  speakersFrom,
} from "./transcript-init.js";
export type { CaptionPreferences, TranscriptEdgInitOptions } from "./transcript-init.js";
