"use client";

/**
 * TypographyPanel (Feature 04-07: Custom Typography Engine & Font Uploader)
 *
 * Provides granular typographic parameter controls:
 * 1. Font Family & Custom Font Uploader (.ttf, .otf, .woff2) with instant DOM @font-face registration.
 * 2. Font Size (32px to 84px), Letter Spacing / Tracking (-2px to +8px), Line Height / Leading.
 * 3. Outer Stroke Width (0px to 16px) & Stroke Color picker.
 * 4. Multi-layer Drop Shadow & Neon Glow.
 * 5. Background Pill / Bounding Box (Color, Opacity, Padding, Corner Radius).
 * 6. 1-click "Save as Workspace Brand Kit Preset".
 */

import {
  ChevronDown,
  Sparkles,
  Upload,
  Bookmark,
  Check,
  AlertCircle,
  Loader2,
} from "lucide-react";
import React, { useRef, useState } from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import { CATALOGUE } from "@montaj/fonts";

import {
  ColourField,
  SelectField,
  SliderField,
  ToggleField,
} from "./panels/controls";
import {
  type PanelScope,
  setStyleField,
  type SetStyleOp,
  toggleWordHighlightGlow,
} from "./panels/ops";

import { cn } from "@/lib/utils";

export interface CustomFontItem {
  readonly id: string;
  readonly family: string;
  readonly fontUrl: string;
  readonly format?: string;
  readonly fontFace?: string;
}

export interface TypographyPanelProps {
  readonly style: StyleDoc;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  readonly base?: StyleDoc;
  readonly customFonts?: readonly CustomFontItem[];
  readonly onUploadFont?: (file: File) => Promise<void> | void;
  readonly onSaveBrandKitPreset?: () => Promise<void> | void;
  readonly canvas?: { width: number; height: number };
  readonly className?: string;
}

const DEFAULT_CANVAS = { width: 1080, height: 1920 };

const FONT_WEIGHT_OPTIONS = [
  { value: 300, label: "Light (300)" },
  { value: 400, label: "Regular (400)" },
  { value: 500, label: "Medium (500)" },
  { value: 600, label: "SemiBold (600)" },
  { value: 700, label: "Bold (700)" },
  { value: 800, label: "ExtraBold (800)" },
  { value: 900, label: "Black (900)" },
];

const TEXT_CASE_OPTIONS = [
  { value: "none", label: "Default" },
  { value: "uppercase", label: "UPPERCASE" },
  { value: "lowercase", label: "lowercase" },
  { value: "capitalize", label: "Capitalize" },
];

const BOX_MODE_OPTIONS = [
  { value: "block", label: "Block" },
  { value: "line", label: "Per Line" },
  { value: "word", label: "Per Word" },
];

function TypographySection({
  title,
  defaultOpen = true,
  children,
}: {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="editor-inspector-section flex shrink-0 flex-col border-b border-border/50 pb-3">
      <h3>
        <button
          type="button"
          onClick={() => setOpen((prior) => !prior)}
          aria-expanded={open}
          className="text-fg-2 hover:text-fg-1 flex h-10 w-full shrink-0 items-center gap-2 text-left transition-colors duration-[160ms]"
        >
          <ChevronDown
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-[160ms]",
              open ? "" : "-rotate-90",
            )}
            aria-hidden="true"
          />
          <span className="text-2xs font-semibold tracking-[0.08em] uppercase">{title}</span>
        </button>
      </h3>
      {open ? <div className="flex flex-col gap-2 pt-1">{children}</div> : null}
    </div>
  );
}

export function TypographyPanel({
  style,
  scope,
  onOp,
  base,
  customFonts = [],
  onUploadFont,
  onSaveBrandKitPreset,
  canvas = DEFAULT_CANVAS,
  className,
}: TypographyPanelProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isSavingPreset, setIsSavingPreset] = useState(false);
  const [presetSaved, setPresetSaved] = useState(false);

  // Combine bundled fonts and custom workspace fonts
  const fontOptions = React.useMemo(() => {
    const bundledNames = Array.from(new Set(CATALOGUE.map((f) => f.family))).sort();
    const customNames = customFonts.map((f) => f.family);
    const allUnique = Array.from(new Set([...customNames, ...bundledNames]));
    return allUnique.map((name) => ({
      value: name,
      label: customNames.includes(name) ? `${name} (Custom)` : name,
    }));
  }, [customFonts]);

  // Handle direct file upload and dynamic @font-face registration
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadMessage(null);
    setUploadError(null);

    try {
      // 1. Dynamic FontFace registration in DOM for immediate live preview
      const arrayBuffer = await file.arrayBuffer();
      const rawFamily = file.name.replace(/\.[^/.]+$/, "").trim();
      const fontFaceName = rawFamily || "CustomFont";

      try {
        const fontFace = new FontFace(fontFaceName, arrayBuffer);
        await fontFace.load();
        document.fonts.add(fontFace);
      } catch (err) {
        console.warn("Could not register local FontFace preview:", err);
      }

      // 2. Upload to backend if custom handler provided or direct endpoint
      if (onUploadFont) {
        await onUploadFont(file);
      } else {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("family", fontFaceName);

        const res = await fetch("/api/v1/fonts/upload", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          // Try fallback endpoint /fonts/upload
          const resFallback = await fetch("/fonts/upload", {
            method: "POST",
            body: formData,
          });
          if (!resFallback.ok) {
            const errJson = await resFallback.json().catch(() => ({}));
            throw new Error(errJson.message || `Upload failed: HTTP ${resFallback.status}`);
          }
          const data = await resFallback.json();
          if (data.fontUrl) {
            onOp(setStyleField(scope, "typography.customFontUrl", data.fontUrl));
          }
        } else {
          const data = await res.json();
          if (data.fontUrl) {
            onOp(setStyleField(scope, "typography.customFontUrl", data.fontUrl));
          }
        }
      }

      // Update family in caption style
      onOp(setStyleField(scope, "typography.fontFamily", fontFaceName));
      setUploadMessage(`Font "${fontFaceName}" uploaded & registered!`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Font upload failed");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSavePreset = async () => {
    setIsSavingPreset(true);
    setPresetSaved(false);
    try {
      if (onSaveBrandKitPreset) {
        await onSaveBrandKitPreset();
      } else {
        // Direct save to presets endpoint
        await fetch("/api/v1/presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `${style.typography.fontFamily} Brand Preset`,
            styleDoc: style,
          }),
        });
      }
      setPresetSaved(true);
      setTimeout(() => setPresetSaved(false), 3000);
    } catch (err) {
      console.error("Failed to save brand kit preset:", err);
    } finally {
      setIsSavingPreset(false);
    }
  };

  const glowOn = style.animation.wordHighlight.type === "glow";

  return (
    <div
      className={cn("typography-engine-panel flex shrink-0 flex-col gap-3 p-3", className)}
      data-testid="typography-panel"
    >
      {/* 1. Font Selection & Custom Uploader */}
      <TypographySection title="Font & Typeface">
        <SelectField
          label="Font Family"
          path="typography.fontFamily"
          value={style.typography.fontFamily}
          options={fontOptions}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        <div className="editor-field-row flex min-h-8 items-center justify-between gap-3">
          <label htmlFor="field-typography-weight" className="text-sm text-fg-1">
            Weight
          </label>
          <select
            id="field-typography-weight"
            value={String(style.typography.weight)}
            onChange={(e) => {
              onOp(setStyleField(scope, "typography.weight", Number(e.target.value)));
            }}
            className="h-8 rounded-sm border border-border bg-bg-2 text-xs text-fg-0 w-[140px] px-2.5 transition-colors hover:border-fg-2/60"
            data-testid="field-typography-weight"
          >
            {FONT_WEIGHT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <SelectField
          label="Text Case"
          path="typography.textTransform"
          value={style.typography.textTransform}
          options={TEXT_CASE_OPTIONS}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {/* Hidden file input for custom font upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".ttf,.otf,.woff2"
          onChange={handleFileChange}
          className="hidden"
          data-testid="custom-font-file-input"
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="bg-bg-2 border-border text-fg-1 hover:text-fg-0 hover:border-fg-2/60 mt-1 flex h-8 items-center justify-center gap-2 rounded-sm border px-3 text-xs font-medium transition-colors"
          data-testid="upload-custom-font-btn"
        >
          {isUploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Upload className="size-3.5" />
          )}
          <span>{isUploading ? "Sanitizing & Registering..." : "Upload Custom Font (.otf, .ttf, .woff2)"}</span>
        </button>

        {uploadMessage && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400" data-testid="upload-success-msg">
            <Check className="size-3" />
            <span>{uploadMessage}</span>
          </p>
        )}
        {uploadError && (
          <p className="flex items-center gap-1.5 text-xs text-rose-400" data-testid="upload-error-msg">
            <AlertCircle className="size-3" />
            <span>{uploadError}</span>
          </p>
        )}
      </TypographySection>

      {/* 2. Granular Sliders: Size, Tracking, Leading */}
      <TypographySection title="Size & Spacing">
        {/* Font Size: 32px to 84px */}
        <SliderField
          label="Font Size"
          path="typography.sizePct"
          value={style.typography.sizePct}
          min={3200 / canvas.height}
          max={8400 / canvas.height}
          step={50 / canvas.height}
          displayScale={canvas.height / 100}
          unit="px"
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {/* Letter Spacing (Tracking): -2px to +8px */}
        <SliderField
          label="Letter Spacing"
          path="typography.letterSpacingEm"
          value={style.typography.letterSpacingEm}
          min={-0.1}
          max={0.4}
          step={0.01}
          unit="em"
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {/* Line Height (Leading): 0.8 to 2.5 */}
        <SliderField
          label="Line Height"
          path="typography.lineHeight"
          value={style.typography.lineHeight}
          min={0.8}
          max={2.5}
          step={0.05}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />
      </TypographySection>

      {/* 3. Outer Stroke Width & Color */}
      <TypographySection title="Outer Stroke">
        <ToggleField
          label="Enable Stroke"
          path="stroke.enabled"
          value={style.stroke.enabled}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {style.stroke.enabled && (
          <>
            <ColourField
              label="Stroke Color"
              path="stroke.color"
              value={style.stroke.color ?? "#000000"}
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />

            {/* Stroke Width: 0px to 16px (0 to 20% of font size) */}
            <SliderField
              label="Stroke Width"
              path="stroke.widthPct"
              value={style.stroke.widthPct}
              min={0}
              max={20}
              step={0.5}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
          </>
        )}
      </TypographySection>

      {/* 4. Multi-Layer Drop Shadow & Neon Glow */}
      <TypographySection title="Shadow & Glow">
        <ToggleField
          label="Drop Shadow"
          path="shadow.enabled"
          value={style.shadow.enabled}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {style.shadow.enabled && (
          <>
            <ColourField
              label="Shadow Color"
              path="shadow.color"
              value={style.shadow.color ?? "#000000"}
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
            <SliderField
              label="Opacity"
              path="shadow.opacity"
              value={style.shadow.opacity}
              min={0}
              max={1}
              step={0.01}
              displayScale={100}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
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
              {...(base === undefined ? {} : { base })}
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
              {...(base === undefined ? {} : { base })}
            />
            <SliderField
              label="Blur Radius"
              path="shadow.blurPct"
              value={style.shadow.blurPct}
              min={0}
              max={100}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
          </>
        )}

        <div className="flex min-h-8 items-center justify-between gap-3 pt-1">
          <span className="text-sm text-fg-1">Neon Glow</span>
          <input
            id="typography-neon-glow"
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
            className="panel-switch"
            data-testid="field-neon-glow"
          />
        </div>
      </TypographySection>

      {/* 5. Background Pill / Bounding Box */}
      <TypographySection title="Background Pill">
        <ToggleField
          label="Enable Pill"
          path="box.enabled"
          value={style.box.enabled}
          scope={scope}
          onOp={onOp}
          {...(base === undefined ? {} : { base })}
        />

        {style.box.enabled && (
          <>
            <SelectField
              label="Pill Mode"
              path="box.mode"
              value={style.box.mode}
              options={BOX_MODE_OPTIONS}
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
            <ColourField
              label="Pill Color"
              path="box.fill"
              value={style.box.fill ?? "#000000"}
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
            <SliderField
              label="Pill Opacity"
              path="box.opacity"
              value={style.box.opacity}
              min={0}
              max={1}
              step={0.01}
              displayScale={100}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
            <SliderField
              label="Padding"
              path="box.paddingPct"
              value={style.box.paddingPct}
              min={0}
              max={100}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
            {/* RadiusPct: 50% is a full pill */}
            <SliderField
              label="Corner Radius"
              path="box.radiusPct"
              value={style.box.radiusPct}
              min={0}
              max={50}
              unit="%"
              scope={scope}
              onOp={onOp}
              {...(base === undefined ? {} : { base })}
            />
          </>
        )}
      </TypographySection>

      {/* 6. 1-Click "Save as Workspace Brand Kit Preset" */}
      <div className="pt-2">
        <button
          type="button"
          onClick={handleSavePreset}
          disabled={isSavingPreset}
          className="bg-primary/20 border-primary/40 text-primary hover:bg-primary/30 flex h-9 w-full items-center justify-center gap-2 rounded-sm border px-3 text-xs font-semibold transition-colors"
          data-testid="save-brand-preset-btn"
        >
          {isSavingPreset ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : presetSaved ? (
            <Check className="size-3.5 text-emerald-400" />
          ) : (
            <Bookmark className="size-3.5" />
          )}
          <span>{presetSaved ? "Brand Preset Saved!" : "Save as Workspace Brand Kit Preset"}</span>
        </button>
      </div>
    </div>
  );
}
