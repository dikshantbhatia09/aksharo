/**
 * The Aksharo caption `.mogrt` param table (C06b).
 *
 * This order and these `displayName`s are **frozen**: C06's `setMogrtParams`
 * resolves by `displayName` with index fallback (03-architecture/05 §6), so a
 * later reorder or rename here is a breaking change to every caller. If a param
 * must change, add a new one at the end and deprecate the old one in
 * `docs/MOGRT-PARAMS.md` rather than reordering.
 *
 * Names match C08b's Resolve Fusion `Text+` macro (`HighlightStart`/`HighlightEnd`
 * sliders, same param names) so the style→param mapping in
 * `src/styles/mogrt-map.ts` is shared prose between the two plugins even though
 * the runtimes differ.
 *
 * `BoxFill`/`BoxOpacity` (indices 12-13) were appended after C08b's Fusion
 * `classification_rules.json` landed and this module's classifier was made to
 * mirror it exactly (see `src/styles/classification-rules.ts`): without a
 * whole-cue background param, every `box.enabled` style would have had to be
 * marked MOGRT-unsupported, which is not the real capability gap — Text+ has
 * a plain Background field and so does an AE shape/solid layer under the text.
 * Appending these two (rather than reordering) keeps the original 12 frozen
 * per the paragraph above; **C06 had not landed when this was added** (`main`
 * was at "Merge wp/C05a") so its own appendix table (12 params) simply
 * predates this pair — flagged for the orchestrator, not silently changed
 * out from under C06.
 */

export type MogrtParamType = "text" | "font" | "color" | "percent" | "number";

export interface MogrtParamDef {
  /** Position in the Essential Graphics panel; the index-fallback key. */
  readonly index: number;
  /** Stable machine name (not shown to the editor). */
  readonly name: string;
  /** Shown in Premiere's Essential Graphics panel; the primary resolution key. */
  readonly displayName: string;
  readonly type: MogrtParamType;
  readonly defaultValue: string | number;
  readonly description: string;
}

/** The frozen order. Do not reorder — see the module doc comment. */
export const MOGRT_PARAM_NAMES = [
  "Text",
  "Font",
  "Size",
  "Colour",
  "StrokeColour",
  "StrokeWidth",
  "ShadowOpacity",
  "PositionY",
  "HighlightColour",
  "HighlightStart",
  "HighlightEnd",
  "StyleId",
  "BoxFill",
  "BoxOpacity",
] as const;

export type MogrtParamName = (typeof MOGRT_PARAM_NAMES)[number];

const DESCRIPTIONS: Record<
  MogrtParamName,
  { type: MogrtParamType; defaultValue: string | number; description: string }
> = {
  Text: {
    type: "text",
    defaultValue: "",
    description: "The cue's caption text for this segment (source text of the AE text layer).",
  },
  Font: {
    type: "font",
    defaultValue: "Inter",
    description:
      "Font family name; must match a family bundled in packages/fonts or installed system-wide (see README-AUTHORING.md).",
  },
  Size: {
    type: "percent",
    defaultValue: 5,
    description:
      "Font size as a percentage of the composition height (mirrors StyleDoc typography.sizePct).",
  },
  Colour: {
    type: "color",
    defaultValue: "#FFFFFF",
    description: "Resting fill colour of the text (StyleDoc colors.text).",
  },
  StrokeColour: {
    type: "color",
    defaultValue: "#000000",
    description: "Stroke/outline colour (StyleDoc stroke.color); ignored when StrokeWidth is 0.",
  },
  StrokeWidth: {
    type: "percent",
    defaultValue: 0,
    description:
      "Stroke width as a percentage of font size (StyleDoc stroke.widthPct); 0 disables the stroke.",
  },
  ShadowOpacity: {
    type: "percent",
    defaultValue: 0,
    description: "Drop shadow opacity 0-100 (StyleDoc shadow.opacity x100); 0 disables the shadow.",
  },
  PositionY: {
    type: "percent",
    defaultValue: 80,
    description:
      "Vertical anchor position as a percentage of composition height (StyleDoc layout.y x100).",
  },
  HighlightColour: {
    type: "color",
    defaultValue: "#FFE14D",
    description:
      "Colour applied to the active word/range while it is spoken (StyleDoc colors.activeText or accent).",
  },
  HighlightStart: {
    type: "percent",
    defaultValue: 0,
    description:
      "Start of the per-character highlight sweep (0-100 of the cue's character range), driven by the word timeline.",
  },
  HighlightEnd: {
    type: "percent",
    defaultValue: 0,
    description: "End of the per-character highlight sweep (0-100 of the cue's character range).",
  },
  StyleId: {
    type: "text",
    defaultValue: "",
    description:
      "The Aksharo style id baked into this instance; read back by the start-up self-test to confirm the param mapping.",
  },
  BoxFill: {
    type: "color",
    defaultValue: "#000000",
    description:
      "Whole-cue background box fill colour (StyleDoc box.fill); has no visible effect while BoxOpacity is 0.",
  },
  BoxOpacity: {
    type: "percent",
    defaultValue: 0,
    description:
      "Whole-cue background box opacity 0-100 (StyleDoc box.opacity x100); 0 hides the box entirely.",
  },
};

/** The 14 frozen params, in order, index 0-13 (0-11 are the original C06 appendix table; 12-13 were appended later, see the module doc comment). */
export const MOGRT_PARAMS: readonly MogrtParamDef[] = MOGRT_PARAM_NAMES.map((name, index) => ({
  index,
  name,
  displayName: name,
  ...DESCRIPTIONS[name],
}));
