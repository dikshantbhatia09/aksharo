import { loadSystemStyles, type StyleDoc } from "@montaj/caption-styles";

import { applyClassificationRules, type ClassificationStatus } from "./classification-rules.js";

import type { MogrtParamName } from "../../mogrt/params.js";

/**
 * Style -> Aksharo caption `.mogrt` param mapping (C06b).
 *
 * Classification runs C08b's shared rule set (`classification-rules.ts`,
 * mirroring `plugins/resolve/aksharo_core_app/fusion/classification_rules.json`)
 * against the same StyleDoc fields, then adds exactly one MOGRT-specific rule
 * (`fontNotBundled`) for a capability gap that has no Resolve equivalent: an
 * AE text layer resolves fonts from the machine's installed font list, so a
 * style naming a family outside `packages/fonts`' bundled OFL pack can't be
 * authored here at all, whereas that risk doesn't apply the same way to
 * Fusion's own font classification.
 *
 * `MOGRT_PARAMS` (`mogrt/params.ts`) includes `BoxFill`/`BoxOpacity` — added
 * specifically so the shared `box-word-mode`/`box-translucent-glass` rules
 * (not a blanket "no box support here") are the only things that downgrade a
 * boxed style, matching C08b's own Text+ Background field capability. Recomputing
 * against the 30 system styles with this param pair present produces the same
 * 19 supported / 6 approximate / 5 unsupported split C08b's own generated
 * report shows, style-for-style (checked by hand against
 * `plugins/resolve/docs/RESOLVE-STYLE-COVERAGE.md`, commit 704c92b on
 * `wp/C08b`, when this was written).
 */

export type MogrtSupport = ClassificationStatus;

export interface MogrtStyleMapping {
  styleId: string;
  support: MogrtSupport;
  /** Every reason that fired, in rule order; empty when support is "supported". */
  reasons: string[];
  /** Which StyleDoc field each frozen param resolves from (always present, even when unsupported — it's what a future capability fix would use). */
  paramSources: Record<MogrtParamName, string>;
}

/**
 * Font families packages/fonts bundles in the desktop installer (OFL pack).
 * A style outside this set cannot be authored into the MOGRT because AE text
 * layers only resolve fonts installed on the authoring/playback machine (see
 * docs/README-AUTHORING.md "Fonts").
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

/** Static field each frozen param resolves from. Runtime-only params carry a prose note instead of a field path. */
export const PARAM_SOURCES: Record<MogrtParamName, string> = {
  Text: "(runtime) the segment/word text for this cue, not a StyleDoc field",
  Font: "typography.fontFamily",
  Size: "typography.sizePct",
  Colour: "colors.text",
  StrokeColour: "stroke.color (stroke.enabled false -> StrokeWidth 0 hides it)",
  StrokeWidth: "stroke.widthPct, or 0 when stroke.enabled is false",
  ShadowOpacity: "shadow.opacity, or 0 when shadow.enabled is false",
  PositionY: "layout.y",
  HighlightColour: "colors.activeText, falling back to colors.accent",
  HighlightStart: "(runtime) start of the active word/range in the cue's character range",
  HighlightEnd: "(runtime) end of the active word/range in the cue's character range",
  StyleId: "id",
  BoxFill: "box.fill",
  BoxOpacity: "box.opacity, or 0 when box.enabled is false",
};

export function classifyStyle(style: StyleDoc): MogrtStyleMapping {
  const { status: sharedStatus, reasons } = applyClassificationRules(style);
  let status = sharedStatus;

  if (!BUNDLED_FONT_FAMILIES.has(style.typography.fontFamily)) {
    status = "unsupported";
    reasons.push(
      `typography.fontFamily "${style.typography.fontFamily}" is not in the bundled OFL pack (packages/fonts); ` +
        "MOGRT text layers can only reference a font installed on the authoring/playback machine",
    );
  }

  return { styleId: style.id, support: status, reasons, paramSources: PARAM_SOURCES };
}

/** Classifies every shipped system style, ordered by id (same order as `loadSystemStyles`). */
export function buildMogrtStyleMap(dir?: string): MogrtStyleMapping[] {
  return loadSystemStyles(dir).map(classifyStyle);
}
