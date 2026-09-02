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
import { StylePreviewCanvas } from "../canvas/StylePreviewCanvas";

import { cn } from "@/lib/utils";

export type PanelTab = "style" | "colors" | "look" | "anim";

export const PANEL_TABS: readonly { readonly id: PanelTab; readonly label: string }[] = [
  { id: "style", label: "Style" },
  { id: "colors", label: "Colors" },
  { id: "look", label: "Look" },
  { id: "anim", label: "Anim" },
];

export interface RightPanelProps {
  readonly styles: readonly StyleDoc[];
  /** The effective style: catalogue document with doc and segment overrides applied. */
  readonly style: StyleDoc;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  readonly onSaveTemplate?: () => void;
  /** Hook for A18b's custom-font upload; the panel only opens the picker. */
  readonly onUploadFont?: () => void;
  readonly className?: string;
}

export function RightPanel({
  styles,
  style,
  scope,
  onOp,
  onSaveTemplate,
  onUploadFont,
  className,
}: RightPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>("style");

  return (
    <aside
      className={cn("flex h-full w-80 flex-col gap-4 p-3", className)}
      data-testid="right-panel"
    >
      <div className="flex gap-1" role="tablist" aria-label="Caption settings">
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

      {tab === "style" ? (
        <StylePicker
          styles={styles}
          selectedStyleId={style.id}
          scope={scope}
          onOp={onOp}
          {...(onSaveTemplate === undefined ? {} : { onSaveTemplate })}
        />
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
