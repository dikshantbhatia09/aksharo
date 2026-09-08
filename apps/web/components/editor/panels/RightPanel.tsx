"use client";

/**
 * The editor's right-hand panel: Style, Colors, Look, Effects and Anim.
 *
 * Every tab is a thin wrapper over `controls.tsx`, and every control emits one
 * `SetStyle` op at the panel's current scope. The scope is the whole point of
 * the design: the same slider writes `styles.inline.doc` when the document is
 * selected and the segment's own `overrides` when a caption is.
 */

import { useState } from "react";

import type { Depth3d, EmphasisPreset, StyleDoc } from "@montaj/caption-styles";
import { CATALOGUE } from "@montaj/fonts";

import { ColourField, SearchSelectField, SelectField, SliderField, ToggleField } from "./controls";
import {
  type PanelScope,
  setStyleField,
  type SetStyleOp,
  toggleWordHighlightGlow,
  withDefaultEmphasisEffect,
  withDefaultEmphasisField,
} from "./ops";
import { DEFAULT_PREVIEW_CANVAS, StylePicker } from "./StylePicker";
import { AudioPanel, type AudioPanelProps } from "../audio/AudioPanel";
import { type CanvasSize, fitPreview } from "../canvas/stage-fit";
import { StylePreviewCanvas } from "../canvas/StylePreviewCanvas";

import { helpUrlFor, type HelpSlug } from "@/components/help/help-slug-map";
import { cn } from "@/lib/utils";

export type PanelTab = "style" | "colors" | "look" | "effects" | "anim" | "audio";

export const PANEL_TABS: readonly { readonly id: PanelTab; readonly label: string }[] = [
  { id: "style", label: "Style" },
  { id: "colors", label: "Colors" },
  { id: "look", label: "Look" },
  { id: "effects", label: "Effects" },
  { id: "anim", label: "Anim" },
  { id: "audio", label: "Audio" },
];

/**
 * Which help article each tab's "?" affordance opens (brief §4). Style,
 * Colors, Look and Effects are all facets of the same caption style
 * document, so they share `caption-styles`; Anim is the per-word/emphasis
 * timing article, which is what its cues (fade/pop/karaoke fill/...) and
 * durations are about; Audio (B10b) has no dedicated article yet, so it
 * falls back to the same `caption-styles` article rather than 404ing or
 * hiding the "?". Copy itself lives in the article, not here — this is only
 * the wiring seam `help-slug-map.ts` documents.
 */
export const PANEL_HELP_SLUGS: Record<PanelTab, HelpSlug> = {
  style: "caption-styles",
  colors: "caption-styles",
  look: "caption-styles",
  effects: "caption-styles",
  anim: "emphasis-timing",
  audio: "caption-styles",
};

/**
 * The Font Family picker's option list (K01 item 1). `@montaj/fonts`'
 * `CATALOGUE` — the same bundled-font list `packages/fonts/src/catalogue.ts`
 * documents as "every `typography.fontFamily` in
 * `packages/caption-styles/styles/*.json`... plus the UI faces... plus one
 * Noto family per script" — is the canonical list this WP's brief asked to
 * find rather than invent; see REPORT.md for the one open question it
 * raises (how many of these faces the browser preview actually has
 * registered today, `apps/web/components/editor/canvas/use-canvaskit.ts`'s
 * `DEFAULT_FONTS`, is A18b's follow-on, not this list's problem).
 */
const FONT_FAMILY_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  Array.from(new Set(CATALOGUE.map((family) => family.family)))
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({ value: family, label: family }));

/** Discrete weight names `typography.weight` (100-900) actually renders as (`FontRegistry`'s nearest-match). */
const FONT_WEIGHT_OPTIONS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "SemiBold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "ExtraBold" },
  { value: 900, label: "Black" },
];

/** The Format section's "Bold" quick-toggle: the boldest weight this style's face offers. */
const BOLD_WEIGHT = 700;
const REGULAR_WEIGHT = 400;

/** A small "?" affordance that opens the help article for the given slug in a new tab. */
function HelpLink({ slug, testId }: { readonly slug: HelpSlug; readonly testId: string }) {
  return (
    <a
      href={helpUrlFor(slug)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open help for this panel"
      title="Help"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs text-white/80 hover:bg-white/20"
      data-testid={testId}
    >
      ?
    </a>
  );
}

export interface RightPanelProps {
  readonly styles: readonly StyleDoc[];
  /** The effective style: catalogue document with doc and segment overrides applied. */
  readonly style: StyleDoc;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  readonly onSaveTemplate?: () => void;
  /** The workspace's saved presets and how to remove one — see `StylePickerProps` for the shape. */
  readonly myPresets?: readonly StyleDoc[];
  readonly onDeletePreset?: (id: string) => void;
  /** Hook for A18b's custom-font upload; the panel only opens the picker. */
  readonly onUploadFont?: () => void;
  /** Props for the Audio tab (B10b); omitted while no project/media context is available. */
  readonly audio?: AudioPanelProps;
  /** The document's canvas, so every preview in the panel uses the project's aspect. */
  readonly canvas?: CanvasSize;
  readonly className?: string;
}

export function RightPanel({
  styles,
  style,
  scope,
  onOp,
  onSaveTemplate,
  myPresets,
  onDeletePreset,
  onUploadFont,
  audio,
  canvas = DEFAULT_PREVIEW_CANVAS,
  className,
}: RightPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>("style");

  return (
    <aside
      className={cn("flex h-full min-h-0 w-80 flex-col gap-4 p-3", className)}
      data-testid="right-panel"
    >
      <div className="flex items-center gap-1">
        <div className="flex flex-1 gap-1" role="tablist" aria-label="Caption settings">
          {PANEL_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
              }}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-sm",
                tab === entry.id ? "bg-white text-black" : "bg-white/10 text-white/80",
              )}
              data-testid={`right-panel-tab-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {/* eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up */}
        <HelpLink slug={PANEL_HELP_SLUGS[tab]} testId={`right-panel-help-${tab}`} />
      </div>

      {tab === "style" ? (
        <StylePicker
          styles={styles}
          selectedStyleId={style.id}
          scope={scope}
          onOp={onOp}
          canvas={canvas}
          className="min-h-0 flex-1"
          {...(onSaveTemplate === undefined ? {} : { onSaveTemplate })}
          {...(myPresets === undefined ? {} : { myPresets })}
          {...(onDeletePreset === undefined ? {} : { onDeletePreset })}
        />
      ) : tab === "audio" ? (
        audio === undefined ? (
          <p className="text-xs text-white/60">Audio clean is not available for this project.</p>
        ) : (
          <AudioPanel {...audio} />
        )
      ) : (
        <>
          {/* shrink-0: a flex column item shrinks below its own height by default,
              which squeezed this preview to 62px and broke the aspect it was
              just given. The explicit size from `fitPreview` is the contract. */}
          <StylePreviewCanvas
            style={style}
            {...fitPreview(canvas, 288, 220)}
            className="shrink-0"
          />
          {tab === "colors" ? <ColorsPanel style={style} scope={scope} onOp={onOp} /> : null}
          {tab === "look" ? (
            <LookPanel
              style={style}
              scope={scope}
              onOp={onOp}
              {...(onUploadFont === undefined ? {} : { onUploadFont })}
            />
          ) : null}
          {tab === "effects" ? <EffectsPanel style={style} scope={scope} onOp={onOp} /> : null}
          {tab === "anim" ? <AnimPanel style={style} scope={scope} onOp={onOp} /> : null}
        </>
      )}
    </aside>
  );
}

interface TabProps {
  readonly style: StyleDoc;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
}

/** A small caps-and-tracked label grouping a run of controls, matching the reference frames' section headers. */
function SectionHeading({ children }: { readonly children: string }): React.JSX.Element {
  return (
    <h3 className="mt-1 text-[11px] font-medium tracking-wide text-white/50 uppercase first:mt-0">
      {children}
    </h3>
  );
}

/**
 * K01 item 7: which `effect` the style's *default* emphasis preset —
 * `emphasisPresets[0]`, the entry `editor-client.tsx`'s `onEmphasize` reads
 * for the right-click "Emphasise word" cycle (`E`, `SegmentCard.tsx`'s
 * context menu) — draws with, once a word carries it. Three options, matching
 * Kalakar's Emphasis/Spotlight/Solid (its fourth, Gradient, is out of scope
 * per this WP's brief): Emphasis glows, Spotlight drops a highlight box
 * behind the word, Solid is a flat recolour with no extra ground. The panel
 * picks the look; the right-click cycle (unchanged) still picks which word
 * gets it — both read and write the same `emphasisPresets[0]` entry, so they
 * can never drift out of sync with each other.
 */
const EMPHASIS_EFFECT_OPTIONS: readonly {
  readonly value: "glow" | "highlight" | "none";
  readonly label: string;
}[] = [
  { value: "glow", label: "Emphasis" },
  { value: "highlight", label: "Spotlight" },
  { value: "none", label: "Solid" },
];

function EmphasisField({ style, scope, onOp }: TabProps): React.JSX.Element | null {
  const defaultPreset = style.emphasisPresets[0];
  if (defaultPreset === undefined) return null;
  const current = defaultPreset.effect ?? "none";
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="emphasis-field">
      <span className="text-white/80">Emphasis</span>
      <div className="flex gap-1" role="radiogroup" aria-label="Default emphasis look">
        {EMPHASIS_EFFECT_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={current === option.value}
            onClick={() => {
              onOp(
                setStyleField(
                  scope,
                  "emphasisPresets",
                  withDefaultEmphasisEffect(style.emphasisPresets, option.value),
                ),
              );
            }}
            className={cn(
              "flex-1 rounded-md px-2 py-1 text-xs",
              current === option.value ? "bg-white text-black" : "bg-white/10 text-white/80",
            )}
            data-testid={`emphasis-field-${option.value}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Reads one leaf a `emphasisPresets.<key>` control just wrote, out of the
 * dotted partial `setStyleField` built for it (`{ emphasisPresets: { <key>:
 * value } }`) — the same trick `EffectsPanel`'s `depth3dLeaf` uses for the
 * optional `depth3d` object, applied here to `emphasisPresets[0]` (an array
 * element, so `setStyleField`'s dotted-path expansion cannot address it
 * directly). This is what lets `SearchSelectField` (hard-wired to call
 * `onOp(setStyleField(scope, path, value))` with its own single-field
 * `path`) still drive one field of the *first* emphasis preset without a
 * bespoke input.
 */
function emphasisPresetLeaf<K extends keyof EmphasisPreset>(
  op: SetStyleOp,
  key: K,
): EmphasisPreset[K] {
  const overrides = op.overrides as { emphasisPresets?: Partial<EmphasisPreset> } | undefined;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed generic key, not attacker-controlled
  return overrides?.emphasisPresets?.[key] as EmphasisPreset[K];
}

/** Element id for the Emphasis Font Face select, which reuses `FONT_WEIGHT_OPTIONS` — the same list as the base style's `WeightField`. */
const EMPHASIS_FONT_WEIGHT_ID = "field-emphasis-weight";

/**
 * K05 item 5: the Emphasis section's own, independent Font/Font Face/Styles
 * group (addendum gap 3, frames 0140-0157) — an emphasised word can use a
 * different font family, weight, slant and underline than the base caption's
 * own `typography`/Format row, applied to `emphasisPresets[0]` (the same
 * entry `EmphasisField` above already reads and writes). Every value shown
 * here falls back to the base style's own typography when the preset has no
 * override yet, matching exactly what `render-core`'s `emphasisTypographyFor`
 * (layout) and `wordCommands` (paint) do — the panel's "effective value" is
 * never out of sync with what the canvas actually draws.
 */
function EmphasisTypographyFields({ style, scope, onOp }: TabProps): React.JSX.Element | null {
  const defaultPreset = style.emphasisPresets[0];
  if (defaultPreset === undefined) return null;

  const effectiveWeight = defaultPreset.weight ?? style.typography.weight;
  const effectiveItalic = defaultPreset.italic ?? style.typography.italic;
  const effectiveUnderline = defaultPreset.underline ?? style.typography.underline === true;

  function setField<K extends keyof EmphasisPreset>(key: K, value: EmphasisPreset[K]): void {
    onOp(
      setStyleField(
        scope,
        "emphasisPresets",
        withDefaultEmphasisField(style.emphasisPresets, key, value),
      ),
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="emphasis-typography-fields">
      <SearchSelectField
        label="Font"
        path="emphasisPresets.fontFamily"
        value={defaultPreset.fontFamily ?? style.typography.fontFamily}
        options={FONT_FAMILY_OPTIONS}
        placeholder="Search fonts…"
        scope={scope}
        onOp={(op) => {
          setField("fontFamily", emphasisPresetLeaf(op, "fontFamily"));
        }}
      />
      <label
        className="flex items-center justify-between gap-3 text-sm"
        htmlFor={EMPHASIS_FONT_WEIGHT_ID}
      >
        <span className="text-white/80">Font Face</span>
        <select
          id={EMPHASIS_FONT_WEIGHT_ID}
          value={String(effectiveWeight)}
          onChange={(event) => {
            setField("weight", Number(event.target.value));
          }}
          className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
          data-testid={EMPHASIS_FONT_WEIGHT_ID}
        >
          {FONT_WEIGHT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-1" role="group" aria-label="Emphasis styles">
        <button
          type="button"
          aria-pressed={effectiveItalic}
          onClick={() => {
            setField("italic", !effectiveItalic);
          }}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-sm italic",
            effectiveItalic ? "bg-white text-black" : "bg-white/10 text-white/80",
          )}
          data-testid="emphasis-italic-toggle"
        >
          I
        </button>
        <button
          type="button"
          aria-pressed={effectiveUnderline}
          onClick={() => {
            setField("underline", !effectiveUnderline);
          }}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-sm underline",
            effectiveUnderline ? "bg-white text-black" : "bg-white/10 text-white/80",
          )}
          data-testid="emphasis-underline-toggle"
        >
          U
        </button>
      </div>
    </div>
  );
}

export function ColorsPanel({ style, scope, onOp }: TabProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="colors-panel">
      <SectionHeading>Color</SectionHeading>
      <ColourField
        label="Text"
        path="colors.text"
        value={style.colors.text}
        scope={scope}
        onOp={onOp}
      />
      <ColourField
        label="Highlight"
        path="colors.activeText"
        value={style.colors.activeText ?? style.colors.text}
        scope={scope}
        onOp={onOp}
      />
      <ColourField
        label="Accent"
        path="colors.accent"
        value={style.colors.accent ?? style.colors.text}
        scope={scope}
        onOp={onOp}
      />
      <SectionHeading>Emphasis</SectionHeading>
      <EmphasisField style={style} scope={scope} onOp={onOp} />
      <EmphasisTypographyFields style={style} scope={scope} onOp={onOp} />
      <SectionHeading>Stroke &amp; background</SectionHeading>
      <ToggleField
        label="Stroke"
        path="stroke.enabled"
        value={style.stroke.enabled}
        scope={scope}
        onOp={onOp}
      />
      <ColourField
        label="Stroke colour"
        path="stroke.color"
        value={style.stroke.color ?? "#000000"}
        scope={scope}
        onOp={onOp}
      />
      <ToggleField
        label="Box"
        path="box.enabled"
        value={style.box.enabled}
        scope={scope}
        onOp={onOp}
      />
      <ColourField
        label="Box fill"
        path="box.fill"
        value={style.box.fill ?? "#000000"}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Box opacity"
        path="box.opacity"
        value={style.box.opacity}
        min={0}
        max={1}
        step={0.05}
        scope={scope}
        onOp={onOp}
      />
    </div>
  );
}

/** Font Face's weight half (K01 item 2) — a plain `<select>`, not `controls.tsx`'s `SelectField`, because `typography.weight` is a number and every `SelectField` option value (an HTML `<select>`'s own value) is always a string. */
function WeightField({ style, scope, onOp }: TabProps): React.JSX.Element {
  const id = "field-typography-weight";
  return (
    <label className="flex items-center justify-between gap-3 text-sm" htmlFor={id}>
      <span className="text-white/80">Font Face</span>
      <select
        id={id}
        value={String(style.typography.weight)}
        onChange={(event) => {
          onOp(setStyleField(scope, "typography.weight", Number(event.target.value)));
        }}
        className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
        data-testid={id}
      >
        {FONT_WEIGHT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * K01 item 3: Bold/Italic/Underline as one quick-toggle row, distinct from
 * (but reading and writing the very same fields as) Font Face's own weight
 * select and italic toggle above — Word-processor-style fast access, exactly
 * like Kalakar's Format row. "Bold" has no dedicated schema field: the
 * schema only has a numeric `weight`, so it toggles between `REGULAR_WEIGHT`
 * and `BOLD_WEIGHT` (brief item 3: "bold can just set weight to the boldest
 * available value"), reading its pressed state as `weight >= BOLD_WEIGHT` so
 * it agrees with whatever the weight select or a system style already set.
 *
 * K05 adds the fourth button, Strikethrough (frames 0145/0157/0337's B/I/U/S
 * group), the same quick-toggle shape as the other three, writing
 * `typography.strikethrough`.
 */
function FormatToggleRow({ style, scope, onOp }: TabProps): React.JSX.Element {
  const bold = style.typography.weight >= BOLD_WEIGHT;
  const underline = style.typography.underline === true;
  const strikethrough = style.typography.strikethrough === true;
  return (
    <div className="flex gap-1" role="group" aria-label="Quick format">
      <button
        type="button"
        aria-pressed={bold}
        onClick={() => {
          onOp(setStyleField(scope, "typography.weight", bold ? REGULAR_WEIGHT : BOLD_WEIGHT));
        }}
        className={cn(
          "flex-1 rounded-md px-2 py-1 text-sm font-bold",
          bold ? "bg-white text-black" : "bg-white/10 text-white/80",
        )}
        data-testid="format-bold-toggle"
      >
        B
      </button>
      <button
        type="button"
        aria-pressed={style.typography.italic}
        onClick={() => {
          onOp(setStyleField(scope, "typography.italic", !style.typography.italic));
        }}
        className={cn(
          "flex-1 rounded-md px-2 py-1 text-sm italic",
          style.typography.italic ? "bg-white text-black" : "bg-white/10 text-white/80",
        )}
        data-testid="format-italic-toggle"
      >
        I
      </button>
      <button
        type="button"
        aria-pressed={underline}
        onClick={() => {
          onOp(setStyleField(scope, "typography.underline", !underline));
        }}
        className={cn(
          "flex-1 rounded-md px-2 py-1 text-sm underline",
          underline ? "bg-white text-black" : "bg-white/10 text-white/80",
        )}
        data-testid="format-underline-toggle"
      >
        U
      </button>
      <button
        type="button"
        aria-pressed={strikethrough}
        onClick={() => {
          onOp(setStyleField(scope, "typography.strikethrough", !strikethrough));
        }}
        className={cn(
          "flex-1 rounded-md px-2 py-1 text-sm line-through",
          strikethrough ? "bg-white text-black" : "bg-white/10 text-white/80",
        )}
        data-testid="format-strikethrough-toggle"
      >
        S
      </button>
    </div>
  );
}

export function LookPanel({
  style,
  scope,
  onOp,
  onUploadFont,
}: TabProps & { readonly onUploadFont?: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="look-panel">
      <SectionHeading>Fonts</SectionHeading>
      <SearchSelectField
        label="Font Family"
        path="typography.fontFamily"
        value={style.typography.fontFamily}
        options={FONT_FAMILY_OPTIONS}
        placeholder="Search fonts…"
        scope={scope}
        onOp={onOp}
      />
      <WeightField style={style} scope={scope} onOp={onOp} />
      <SliderField
        label="Size"
        path="typography.sizePct"
        value={style.typography.sizePct}
        min={1}
        max={20}
        step={0.1}
        unit="%"
        scope={scope}
        onOp={onOp}
      />
      <SectionHeading>Format</SectionHeading>
      <FormatToggleRow style={style} scope={scope} onOp={onOp} />
      <SelectField
        label="Case"
        path="typography.textTransform"
        value={style.typography.textTransform}
        options={[
          { value: "none", label: "As spoken" },
          { value: "uppercase", label: "UPPERCASE" },
          { value: "lowercase", label: "lowercase" },
          { value: "capitalize", label: "Capitalise" },
        ]}
        scope={scope}
        onOp={onOp}
      />
      <SelectField
        label="Align"
        path="layout.align"
        value={style.layout.align}
        options={[
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
          { value: "right", label: "Right" },
        ]}
        scope={scope}
        onOp={onOp}
      />
      <SectionHeading>Position</SectionHeading>
      <SliderField
        label="X"
        path="layout.x"
        value={style.layout.x}
        min={0}
        max={1}
        step={0.01}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Y"
        path="layout.y"
        value={style.layout.y}
        min={0}
        max={1}
        step={0.01}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Max width"
        path="layout.maxWidthPct"
        value={style.layout.maxWidthPct}
        min={20}
        max={100}
        unit="%"
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Max lines"
        path="layout.maxLines"
        value={style.layout.maxLines}
        min={1}
        max={4}
        scope={scope}
        onOp={onOp}
      />
      <SectionHeading>Spacing</SectionHeading>
      <SliderField
        label="Letter spacing"
        path="typography.letterSpacingEm"
        value={style.typography.letterSpacingEm}
        min={-0.2}
        max={0.5}
        step={0.01}
        unit="em"
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Line height"
        path="typography.lineHeight"
        value={style.typography.lineHeight}
        min={0.8}
        max={2}
        step={0.02}
        scope={scope}
        onOp={onOp}
      />
      {onUploadFont === undefined ? null : (
        <button
          type="button"
          onClick={onUploadFont}
          className="rounded-md bg-white/10 px-3 py-2 text-sm"
          data-testid="look-panel-upload-font"
        >
          Upload a font
        </button>
      )}
    </div>
  );
}

/** Matches `animate.ts`'s own `DEPTH3D_DEFAULT_LAYERS`. */
const DEFAULT_DEPTH3D_LAYERS = 6;

/** `depth3d`'s display default while the style has none yet. */
const DEFAULT_DEPTH3D: Depth3d = {
  enabled: false,
  color: "#000000",
  offsetPct: 6,
  layers: DEFAULT_DEPTH3D_LAYERS,
};

/**
 * Reads one leaf a `depth3d.<key>` control just wrote, out of the dotted
 * partial `setStyleField` built for it (`{ depth3d: { <key>: value } }`).
 * `depth3d` is optional and most styles have none yet, so every write here
 * has to carry the *whole* object — `mergeOverrides` replaces an object leaf
 * wholesale rather than merging a partial one in, and a bare
 * `{ depth3d: { enabled: true } }` override would leave `color`/`offsetPct`
 * missing and fail the schema. This is what lets `ColourField`/`SliderField`/
 * `ToggleField` (each hard-wired to call `onOp(setStyleField(scope, path,
 * value))` with its own single-field `path`) still drive a field inside an
 * optional nested object without a bespoke input for each one.
 */
function depth3dLeaf<K extends keyof Depth3d>(op: SetStyleOp, key: K): Depth3d[K] {
  const overrides = op.overrides as { depth3d?: Partial<Depth3d> } | undefined;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed generic key, not attacker-controlled
  return overrides?.depth3d?.[key] as Depth3d[K];
}

/**
 * K01: Drop Shadow, Glow and 3D Depth as their own toggleable Effects group,
 * matching reference frame `frame_0160.png`'s Effects list (Text Stroke and
 * Background are already toggle+colour controls on the Colors tab and are
 * out of this WP's scope to move).
 */
export function EffectsPanel({ style, scope, onOp }: TabProps): React.JSX.Element {
  const depth = style.depth3d ?? DEFAULT_DEPTH3D;
  const glowOn = style.animation.wordHighlight.type === "glow";

  return (
    <div className="flex flex-col gap-3" data-testid="effects-panel">
      <SectionHeading>Drop shadow</SectionHeading>
      <ToggleField
        label="Enabled"
        path="shadow.enabled"
        value={style.shadow.enabled}
        scope={scope}
        onOp={onOp}
      />
      <ColourField
        label="Colour"
        path="shadow.color"
        value={style.shadow.color ?? "#000000"}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Opacity"
        path="shadow.opacity"
        value={style.shadow.opacity}
        min={0}
        max={1}
        step={0.05}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Offset X"
        path="shadow.offsetXPct"
        value={style.shadow.offsetXPct}
        min={-50}
        max={50}
        unit="%"
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Offset Y"
        path="shadow.offsetYPct"
        value={style.shadow.offsetYPct}
        min={-50}
        max={50}
        unit="%"
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="Blur"
        path="shadow.blurPct"
        value={style.shadow.blurPct}
        min={0}
        max={100}
        unit="%"
        scope={scope}
        onOp={onOp}
      />

      <SectionHeading>Glow</SectionHeading>
      <label
        className="flex items-center justify-between gap-3 text-sm"
        htmlFor="field-effects-glow"
      >
        <span className="text-white/80">Enabled</span>
        <input
          id="field-effects-glow"
          type="checkbox"
          checked={glowOn}
          onChange={() => {
            onOp(
              setStyleField(
                scope,
                "animation.wordHighlight.type",
                toggleWordHighlightGlow(style.animation.wordHighlight.type),
              ),
            );
          }}
          data-testid="field-effects-glow"
        />
      </label>
      <p className="text-xs text-white/50">
        Glow colours the word being spoken with the Colors tab&apos;s Accent colour — the same look
        the Anim tab&apos;s Word highlight &quot;Glow&quot; option draws.
      </p>

      <SectionHeading>3D depth</SectionHeading>
      <ToggleField
        label="Enabled"
        path="depth3d.enabled"
        value={depth.enabled}
        scope={scope}
        onOp={(op) => {
          onOp(setStyleField(scope, "depth3d", { ...depth, enabled: depth3dLeaf(op, "enabled") }));
        }}
      />
      <ColourField
        label="Colour"
        path="depth3d.color"
        value={depth.color}
        scope={scope}
        onOp={(op) => {
          onOp(setStyleField(scope, "depth3d", { ...depth, color: depth3dLeaf(op, "color") }));
        }}
      />
      <SliderField
        label="Offset"
        path="depth3d.offsetPct"
        value={depth.offsetPct}
        min={0}
        max={20}
        step={0.5}
        unit="%"
        scope={scope}
        onOp={(op) => {
          onOp(
            setStyleField(scope, "depth3d", { ...depth, offsetPct: depth3dLeaf(op, "offsetPct") }),
          );
        }}
      />
      <SliderField
        label="Layers"
        path="depth3d.layers"
        value={depth.layers ?? DEFAULT_DEPTH3D_LAYERS}
        min={1}
        max={8}
        step={1}
        scope={scope}
        onOp={(op) => {
          onOp(setStyleField(scope, "depth3d", { ...depth, layers: depth3dLeaf(op, "layers") }));
        }}
      />
    </div>
  );
}

/**
 * K05: the nine transitions Kalakar names (frames 0251/0253) plus the three
 * our own styles already ship (`typewriter`/`bounce`/`blur`) that Kalakar's
 * list does not name — additive to K01's original eight, appended after them
 * so nothing already wired to an index or a fixture moves. `cuePhase` in
 * `packages/render-core/src/animate/animate.ts` documents each new type's
 * exact motion.
 */
const CUE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "pop", label: "Pop" },
  { value: "slide-up", label: "Slide up" },
  { value: "slide-down", label: "Slide down" },
  { value: "typewriter", label: "Typewriter" },
  { value: "bounce", label: "Bounce" },
  { value: "blur", label: "Blur" },
  { value: "zoom", label: "Zoom" },
  { value: "scale", label: "Scale" },
  { value: "slide-left", label: "Slide left" },
  { value: "slide-right", label: "Slide right" },
  { value: "rise", label: "Rise" },
  { value: "hide", label: "Hide" },
] as const;

export function AnimPanel({ style, scope, onOp }: TabProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="anim-panel">
      <SelectField
        label="In"
        path="animation.in.type"
        value={style.animation.in.type}
        options={CUE_OPTIONS}
        scope={scope}
        onOp={onOp}
      />
      <SliderField
        label="In duration"
        path="animation.in.durationMs"
        value={style.animation.in.durationMs}
        min={0}
        max={1000}
        step={10}
        unit="ms"
        scope={scope}
        onOp={onOp}
      />
      <SelectField
        label="Out"
        path="animation.out.type"
        value={style.animation.out.type}
        options={CUE_OPTIONS}
        scope={scope}
        onOp={onOp}
      />
      {/*
        K05 item 2: Kalakar's "Transitions will be Applied on Line"/"on
        Word" toggle. Genuinely distinct from "One word at a time" below —
        that flag (`perWord`) controls which words are *visible* at all;
        this one (`cueScope`) controls whether the already-visible word(s)
        animate in/out together as one block or each on its own timing. See
        `AnimationSchema.cueScope`'s doc comment for how the two compose.
      */}
      <SelectField
        label="Applied on"
        path="animation.cueScope"
        value={style.animation.cueScope ?? "line"}
        options={[
          { value: "line", label: "Line" },
          { value: "word", label: "Word" },
        ]}
        scope={scope}
        onOp={onOp}
      />
      {/*
        K05 item 3: Kalakar's "Speed Mode: Dynamic" ("Automatically
        calculated based on timing") — when on, `render-core` derives the
        in/out duration from the caption's own on-screen span instead of
        the fixed sliders above (`dynamicCueDurationMs`); off (the default)
        behaves exactly as before this WP.
      */}
      <ToggleField
        label="Speed Mode: Dynamic"
        path="animation.dynamicSpeed"
        value={style.animation.dynamicSpeed === true}
        scope={scope}
        onOp={onOp}
      />
      <SelectField
        label="Word highlight"
        path="animation.wordHighlight.type"
        value={style.animation.wordHighlight.type}
        options={[
          { value: "none", label: "None" },
          { value: "color", label: "Colour" },
          { value: "scale", label: "Scale" },
          { value: "box", label: "Box" },
          { value: "underline", label: "Underline" },
          { value: "karaoke-fill", label: "Karaoke fill" },
          { value: "glow", label: "Glow" },
        ]}
        scope={scope}
        onOp={onOp}
      />
      <ToggleField
        label="One word at a time"
        path="animation.perWord"
        value={style.animation.perWord}
        scope={scope}
        onOp={onOp}
      />
    </div>
  );
}
