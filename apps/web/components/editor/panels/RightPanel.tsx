"use client";

/**
 * The editor's right-hand panel: Style, Colors, Look and Anim.
 *
 * Every tab is a thin wrapper over `controls.tsx`, and every control emits one
 * `SetStyle` op at the panel's current scope. The scope is the whole point of
 * the design: the same slider writes `styles.inline.doc` when the document is
 * selected and the segment's own `overrides` when a caption is.
 */

import { useState } from "react";

import type { StyleDoc } from "@montaj/caption-styles";

import { ColourField, SelectField, SliderField, ToggleField } from "./controls";
import { type PanelScope, type SetStyleOp } from "./ops";
import { StylePicker } from "./StylePicker";
import { AudioPanel, type AudioPanelProps } from "../audio/AudioPanel";
import { StylePreviewCanvas } from "../canvas/StylePreviewCanvas";

import { helpUrlFor, type HelpSlug } from "@/components/help/help-slug-map";
import { cn } from "@/lib/utils";

export type PanelTab = "style" | "colors" | "look" | "anim" | "audio";

export const PANEL_TABS: readonly { readonly id: PanelTab; readonly label: string }[] = [
  { id: "style", label: "Style" },
  { id: "colors", label: "Colors" },
  { id: "look", label: "Look" },
  { id: "anim", label: "Anim" },
  { id: "audio", label: "Audio" },
];

/**
 * Which help article each tab's "?" affordance opens (brief §4). Style,
 * Colors and Look are all facets of the same caption style document, so they
 * share `caption-styles`; Anim is the per-word/emphasis timing article,
 * which is what its cues (fade/pop/karaoke fill/...) and durations are
 * about; Audio (B10b) has no dedicated article yet, so it falls back to the
 * same `caption-styles` article rather than 404ing or hiding the "?".
 * Copy itself lives in the article, not here — this is only the wiring seam
 * `help-slug-map.ts` documents.
 */
export const PANEL_HELP_SLUGS: Record<PanelTab, HelpSlug> = {
  style: "caption-styles",
  colors: "caption-styles",
  look: "caption-styles",
  anim: "emphasis-timing",
  audio: "caption-styles",
};

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
  /** Hook for A18b's custom-font upload; the panel only opens the picker. */
  readonly onUploadFont?: () => void;
  /** Props for the Audio tab (B10b); omitted while no project/media context is available. */
  readonly audio?: AudioPanelProps;
  readonly className?: string;
}

export function RightPanel({
  styles,
  style,
  scope,
  onOp,
  onSaveTemplate,
  onUploadFont,
  audio,
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
          className="min-h-0 flex-1"
          {...(onSaveTemplate === undefined ? {} : { onSaveTemplate })}
        />
      ) : tab === "audio" ? (
        audio === undefined ? (
          <p className="text-xs text-white/60">Audio clean is not available for this project.</p>
        ) : (
          <AudioPanel {...audio} />
        )
      ) : (
        <>
          <StylePreviewCanvas style={style} width={288} height={162} className="w-full" />
          {tab === "colors" ? <ColorsPanel style={style} scope={scope} onOp={onOp} /> : null}
          {tab === "look" ? (
            <LookPanel
              style={style}
              scope={scope}
              onOp={onOp}
              {...(onUploadFont === undefined ? {} : { onUploadFont })}
            />
          ) : null}
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

export function ColorsPanel({ style, scope, onOp }: TabProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="colors-panel">
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

export function LookPanel({
  style,
  scope,
  onOp,
  onUploadFont,
}: TabProps & { readonly onUploadFont?: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="look-panel">
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
      <SliderField
        label="Position"
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

export function AnimPanel({ style, scope, onOp }: TabProps): React.JSX.Element {
  const cueOptions = [
    { value: "none", label: "None" },
    { value: "fade", label: "Fade" },
    { value: "pop", label: "Pop" },
    { value: "slide-up", label: "Slide up" },
    { value: "slide-down", label: "Slide down" },
    { value: "typewriter", label: "Typewriter" },
    { value: "bounce", label: "Bounce" },
    { value: "blur", label: "Blur" },
  ] as const;

  return (
    <div className="flex flex-col gap-3" data-testid="anim-panel">
      <SelectField
        label="In"
        path="animation.in.type"
        value={style.animation.in.type}
        options={cueOptions}
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
        options={cueOptions}
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
