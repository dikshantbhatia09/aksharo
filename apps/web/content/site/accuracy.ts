/**
 * The Features page's accuracy section (A24 brief: "accuracy section shows a
 * placeholder for the published WER table with 'measured on our public eval
 * set' (numbers filled after D08)").
 *
 * The target numbers quoted are the success metrics already decided in
 * 02-product-vision.md §Success metrics — not this page's invention — kept
 * separate from the "current, measured" row, which stays a placeholder because
 * no eval run has published a number yet.
 */

export interface WerRow {
  readonly language: string;
  readonly targetWer: string;
  readonly measuredWer: string | null;
}

export const WER_TARGET_NOTE =
  "Targets from 02-product-vision.md §Success metrics. The measured column fills in once the public eval run (D08) publishes.";

export const WER_ROWS: readonly WerRow[] = [
  { language: "Hindi–English code-mixed (Hinglish)", targetWer: "≤ 12%", measuredWer: null },
  { language: "English", targetWer: "≤ 8%", measuredWer: null },
  { language: "Indic alignment error (all languages)", targetWer: "≤ 80 ms", measuredWer: null },
];
