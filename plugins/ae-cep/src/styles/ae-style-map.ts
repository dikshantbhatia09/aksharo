import { loadSystemStyles, type StyleDoc } from "@montaj/caption-styles";

import { applyClassificationRules, type ClassificationStatus } from "./classification-rules.js";

/**
 * Style -> AE styled-text-layer support (this WP's mirror of C06b's
 * `plugins/premiere-uxp/src/styles/mogrt-map.ts`).
 *
 * Classification runs the same shared rule set (`classification-rules.ts`, mirroring
 * `plugins/resolve/aksharo_core_app/fusion/classification_rules.json`) against the same
 * StyleDoc fields C08b/C06b do, then adds exactly one AE-specific rule (`fontNotBundled`) for
 * the same capability gap C06b's MOGRT mapping has: an AE text layer resolves fonts from the
 * machine's installed font list, so a style naming a family outside `packages/fonts`' bundled
 * OFL pack can't be authored here at all.
 */
export type AeTextLayerSupport = ClassificationStatus;

export interface AeStyleMapping {
  styleId: string;
  support: AeTextLayerSupport;
  /** Every reason that fired, in rule order; empty when support is "supported". */
  reasons: string[];
}

/**
 * Font families `packages/fonts` bundles in the desktop installer (OFL pack) — same list
 * `plugins/premiere-uxp/src/styles/mogrt-map.ts` uses, since both hosts share the identical
 * constraint (a text layer only resolves fonts installed on the authoring/playback machine).
 * Hand-copied rather than imported for the same file-boundary reason `classification-rules.ts`
 * gives (this package may not import `plugins/premiere-uxp/**`).
 */
export const BUNDLED_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "Inter",
  "Montserrat",
  "Poppins",
  "Playfair Display",
  "Roboto Mono",
  "Anton",
  "Bricolage Grotesque",
  "JetBrains Mono",
  "Noto Sans",
  "Noto Sans Devanagari",
  "Noto Sans Bengali",
  "Noto Sans Gurmukhi",
  "Noto Sans Gujarati",
  "Noto Sans Oriya",
  "Noto Sans Tamil",
  "Noto Sans Telugu",
  "Noto Sans Kannada",
  "Noto Sans Malayalam",
  "Noto Sans Ol Chiki",
  "Noto Sans Meetei Mayek",
  "Noto Sans Arabic",
]);

export function classifyStyle(style: StyleDoc): AeStyleMapping {
  const { status: sharedStatus, reasons } = applyClassificationRules(style);
  let status = sharedStatus;

  if (!BUNDLED_FONT_FAMILIES.has(style.typography.fontFamily)) {
    status = "unsupported";
    reasons.push(
      `typography.fontFamily "${style.typography.fontFamily}" is not in the bundled OFL pack (packages/fonts); ` +
        "AE text layers can only reference a font installed on the authoring/playback machine",
    );
  }

  return { styleId: style.id, support: status, reasons };
}

/** Classifies every shipped system style, ordered by id (same order as `loadSystemStyles`). */
export function buildAeStyleMap(dir?: string): AeStyleMapping[] {
  return loadSystemStyles(dir).map(classifyStyle);
}
