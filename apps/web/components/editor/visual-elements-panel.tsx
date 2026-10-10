"use client";

import * as React from "react";
import { Badge, Button, cn } from "@montaj/ui";
import type {
  ProgressBarPosition,
  ProgressBarSettings,
  ProgressBarType,
} from "@montaj/caption-styles";

export interface VisualElementsPanelProps {
  /** Current progress bar configuration settings */
  readonly settings?: Partial<ProgressBarSettings>;
  /** Callback fired whenever any progress bar setting changes */
  readonly onSettingsChange?: (settings: ProgressBarSettings) => void;
  /** Direct callback when toggled */
  readonly onToggle?: (enabled: boolean) => void;
  /** Direct callback when type changes */
  readonly onTypeChange?: (type: ProgressBarType) => void;
  /** Direct callback when color changes */
  readonly onColorChange?: (color: string) => void;
  /** Direct callback when position changes */
  readonly onPositionChange?: (position: ProgressBarPosition) => void;
  /** Direct callback when height changes */
  readonly onHeightChange?: (heightPx: number) => void;
  /** Whether controls are disabled */
  readonly disabled?: boolean;
  /** Optional container class name */
  readonly className?: string;
}

export const PROGRESS_BAR_STYLE_OPTIONS: readonly {
  readonly id: ProgressBarType;
  readonly label: string;
  readonly description: string;
  readonly icon: string;
}[] = [
  {
    id: "SLIM_LINE",
    label: "Slim Line",
    description: "Clean 4-6px bar sweeping from 0% to 100%",
    icon: "━",
  },
  {
    id: "NEON_GRADIENT",
    label: "Neon Glow",
    description: "Vibrant neon gradient with glowing lead cursor",
    icon: "✨",
  },
  {
    id: "RADIAL_DIAL",
    label: "Radial Clock",
    description: "Minimalist circular dial countdown in corner",
    icon: "⏱",
  },
];

export const PROGRESS_BAR_POSITION_OPTIONS: readonly {
  readonly id: ProgressBarPosition;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    id: "BOTTOM_SAFE",
    label: "Bottom Safe",
    description: "Above TikTok/Reels UI chrome (Y=1450px)",
  },
  {
    id: "TOP",
    label: "Top",
    description: "Below status bar (Y=160px)",
  },
  {
    id: "BELOW_VIDEO",
    label: "Below Video",
    description: "Directly under 16:9 video frame",
  },
];

export const COLOR_SWATCH_PRESETS: readonly {
  readonly color: string;
  readonly name: string;
}[] = [
  { color: "#00FFA3", name: "Cyber Green" },
  { color: "#00E5FF", name: "Electric Cyan" },
  { color: "#FF007F", name: "Hot Pink" },
  { color: "#FFF000", name: "Neon Yellow" },
  { color: "#A855F7", name: "Electric Violet" },
  { color: "#FFFFFF", name: "Pure White" },
];

export const HEIGHT_PRESETS: readonly number[] = [4, 6, 8, 12, 16];

/**
 * VisualElementsPanel (Pillar 6 §05: Animated Progress Bars & Timers).
 *
 * Implements Vidyo.ai & Submagic grade interactive video duration indicators:
 * 1. Global toggle switch: [x] Show Progress Bar.
 * 2. Visual style selector: Slim Line | Neon Glow | Radial Clock.
 * 3. Platform safe-zone positioning: Bottom Safe | Top | Below Video.
 * 4. Hex color picker with curated viral neon palette swatches.
 * 5. Height thickness slider / buttons and neon edge glow switch.
 * 6. Live interactive preview scrub bar.
 */
export function VisualElementsPanel({
  settings: initialSettings,
  onSettingsChange,
  onToggle,
  onTypeChange,
  onColorChange,
  onPositionChange,
  onHeightChange,
  disabled = false,
  className,
}: VisualElementsPanelProps): React.JSX.Element {
  const [enabled, setEnabled] = React.useState<boolean>(initialSettings?.enabled ?? true);
  const [type, setType] = React.useState<ProgressBarType>(initialSettings?.type ?? "SLIM_LINE");
  const [position, setPosition] = React.useState<ProgressBarPosition>(
    initialSettings?.position ?? "BOTTOM_SAFE",
  );
  const [heightPx, setHeightPx] = React.useState<number>(initialSettings?.heightPx ?? 6);
  const [fillColor, setFillColor] = React.useState<string>(
    initialSettings?.fillColor ?? "#00FFA3",
  );
  const [trackColor, setTrackColor] = React.useState<string>(
    initialSettings?.trackColor ?? "rgba(255, 255, 255, 0.25)",
  );
  const [glow, setGlow] = React.useState<boolean>(initialSettings?.glow ?? false);
  const [paddingSafePx, setPaddingSafePx] = React.useState<number>(
    initialSettings?.paddingSafePx ?? 24,
  );
  const [previewProgress, setPreviewProgress] = React.useState<number>(0.65);

  React.useEffect(() => {
    if (initialSettings?.enabled !== undefined) setEnabled(initialSettings.enabled);
    if (initialSettings?.type !== undefined) setType(initialSettings.type);
    if (initialSettings?.position !== undefined) setPosition(initialSettings.position);
    if (initialSettings?.heightPx !== undefined) setHeightPx(initialSettings.heightPx);
    if (initialSettings?.fillColor !== undefined) setFillColor(initialSettings.fillColor);
    if (initialSettings?.trackColor !== undefined) setTrackColor(initialSettings.trackColor);
    if (initialSettings?.glow !== undefined) setGlow(initialSettings.glow);
    if (initialSettings?.paddingSafePx !== undefined) setPaddingSafePx(initialSettings.paddingSafePx);
  }, [initialSettings]);

  const notifyChange = React.useCallback(
    (overrides: Partial<ProgressBarSettings>) => {
      const next: ProgressBarSettings = {
        enabled: overrides.enabled ?? enabled,
        type: overrides.type ?? type,
        position: overrides.position ?? position,
        heightPx: overrides.heightPx ?? heightPx,
        fillColor: overrides.fillColor ?? fillColor,
        trackColor: overrides.trackColor ?? trackColor,
        glow: overrides.glow ?? glow,
        paddingSafePx: overrides.paddingSafePx ?? paddingSafePx,
      };
      onSettingsChange?.(next);
    },
    [enabled, type, position, heightPx, fillColor, trackColor, glow, paddingSafePx, onSettingsChange],
  );

  const handleToggle = React.useCallback(
    (newVal: boolean) => {
      setEnabled(newVal);
      onToggle?.(newVal);
      notifyChange({ enabled: newVal });
    },
    [onToggle, notifyChange],
  );

  const handleTypeChange = React.useCallback(
    (newType: ProgressBarType) => {
      setType(newType);
      onTypeChange?.(newType);
      notifyChange({ type: newType });
    },
    [onTypeChange, notifyChange],
  );

  const handlePositionChange = React.useCallback(
    (newPos: ProgressBarPosition) => {
      setPosition(newPos);
      onPositionChange?.(newPos);
      notifyChange({ position: newPos });
    },
    [onPositionChange, notifyChange],
  );

  const handleColorChange = React.useCallback(
    (newColor: string) => {
      setFillColor(newColor);
      onColorChange?.(newColor);
      notifyChange({ fillColor: newColor });
    },
    [onColorChange, notifyChange],
  );

  const handleHeightChange = React.useCallback(
    (newHeight: number) => {
      setHeightPx(newHeight);
      onHeightChange?.(newHeight);
      notifyChange({ heightPx: newHeight });
    },
    [onHeightChange, notifyChange],
  );

  const handleGlowToggle = React.useCallback(
    (newGlow: boolean) => {
      setGlow(newGlow);
      notifyChange({ glow: newGlow });
    },
    [notifyChange],
  );

  return (
    <div
      className={cn("flex flex-col gap-5 p-4 rounded-xl border border-white/10 bg-black/40 text-white", className)}
      data-testid="visual-elements-panel"
    >
      {/* 1. Header & Primary Toggle */}
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">Progress Bar & Timers</span>
            <Badge tone="neutral" className="border border-emerald-500/40 text-emerald-400 text-xs px-1.5 py-0">
              +28% Retention
            </Badge>
          </div>
          <span className="text-xs text-white/60">
            Frame-accurate visual duration indicator
          </span>
        </div>

        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            id="progress-bar-enabled-toggle"
            data-testid="progress-bar-enabled-switch"
            role="switch"
            aria-checked={enabled}
            checked={enabled}
            disabled={disabled}
            onChange={(e) => handleToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500" />
        </label>
      </div>

      {enabled ? (
        <div className="flex flex-col gap-5" data-testid="progress-bar-controls-container">
          {/* 2. Visual Style Selector */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-white/80">Style Design</label>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Style Design">
              {PROGRESS_BAR_STYLE_OPTIONS.map((opt) => {
                const isSelected = type === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-testid={`progress-style-${opt.id}`}
                    disabled={disabled}
                    onClick={() => handleTypeChange(opt.id)}
                    className={cn(
                      "flex flex-col items-center gap-1 p-2.5 rounded-lg border text-xs font-medium transition-colors text-center",
                      isSelected
                        ? "border-emerald-400 bg-emerald-500/15 text-emerald-300"
                        : "border-white/10 bg-white/5 hover:bg-white/10 text-white/80",
                      disabled && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <span className="text-lg">{opt.icon}</span>
                    <span className="font-semibold">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Safe-Zone Position Selector */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-white/80">Placement (Safe Zones)</label>
              <span className="text-[10px] text-white/40">Safe against TikTok chrome</span>
            </div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Placement">
              {PROGRESS_BAR_POSITION_OPTIONS.map((pos) => {
                const isSelected = position === pos.id;
                return (
                  <button
                    key={pos.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    data-testid={`progress-position-${pos.id}`}
                    disabled={disabled}
                    onClick={() => handlePositionChange(pos.id)}
                    className={cn(
                      "flex flex-col items-center p-2 rounded-lg border text-xs font-medium transition-colors text-center",
                      isSelected
                        ? "border-emerald-400 bg-emerald-500/15 text-emerald-300"
                        : "border-white/10 bg-white/5 hover:bg-white/10 text-white/80",
                      disabled && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <span>{pos.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 4. Color Swatches & Custom Hex */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-white/80">Accent Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {COLOR_SWATCH_PRESETS.map((swatch) => {
                const isSelected = fillColor.toLowerCase() === swatch.color.toLowerCase();
                return (
                  <button
                    key={swatch.color}
                    type="button"
                    title={swatch.name}
                    aria-label={swatch.name}
                    data-testid={`color-swatch-${swatch.color}`}
                    disabled={disabled}
                    onClick={() => handleColorChange(swatch.color)}
                    style={{ backgroundColor: swatch.color }}
                    className={cn(
                      "w-7 h-7 rounded-full border-2 transition-transform",
                      isSelected
                        ? "border-white scale-110 shadow-lg shadow-white/20 ring-2 ring-emerald-400"
                        : "border-transparent hover:scale-105",
                      disabled && "opacity-50 cursor-not-allowed",
                    )}
                  />
                );
              })}
              <div className="flex items-center gap-1.5 ml-auto">
                <input
                  type="text"
                  data-testid="progress-bar-color-input"
                  value={fillColor}
                  disabled={disabled}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="w-24 px-2 py-1 text-xs rounded border border-white/20 bg-white/5 text-white font-mono uppercase focus:outline-none focus:border-emerald-400"
                />
              </div>
            </div>
          </div>

          {/* 5. Thickness & Glow Options */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-white/80">Thickness</label>
              <div className="flex items-center gap-1.5">
                {HEIGHT_PRESETS.map((h) => {
                  const isSelected = heightPx === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      data-testid={`height-preset-${h}`}
                      disabled={disabled}
                      onClick={() => handleHeightChange(h)}
                      className={cn(
                        "px-2 py-1 rounded text-xs border font-mono transition-colors",
                        isSelected
                          ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                          : "border-white/10 bg-white/5 hover:bg-white/10 text-white/70",
                      )}
                    >
                      {h}px
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-white/80">Neon Glow</label>
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="progress-bar-glow-toggle"
                  data-testid="progress-bar-glow-toggle"
                  checked={glow}
                  disabled={disabled}
                  onChange={(e) => handleGlowToggle(e.target.checked)}
                  className="rounded border-white/20 text-emerald-500 focus:ring-emerald-400"
                />
                <label htmlFor="progress-bar-glow-toggle" className="text-xs text-white/70 cursor-pointer">
                  High-Impact Glow
                </label>
              </div>
            </div>
          </div>

          {/* 6. Live Interactive Preview Scrub Bar */}
          <div
            className="flex flex-col gap-2 pt-3 border-t border-white/10"
            data-testid="progress-bar-live-preview"
          >
            <div className="flex items-center justify-between text-xs text-white/60">
              <span>Interactive Preview</span>
              <span>{Math.round(previewProgress * 100)}%</span>
            </div>
            <div
              className="relative w-full h-8 rounded-lg bg-neutral-900 border border-white/10 overflow-hidden flex items-center px-2 cursor-pointer"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                setPreviewProgress(p);
              }}
            >
              {type === "RADIAL_DIAL" ? (
                <div className="flex items-center gap-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90">
                    <circle cx="12" cy="12" r="9" fill="none" stroke={trackColor} strokeWidth="3" />
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke={fillColor}
                      strokeWidth="3"
                      strokeDasharray={2 * Math.PI * 9}
                      strokeDashoffset={2 * Math.PI * 9 * (1 - previewProgress)}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="text-xs font-mono text-white/80">Radial Countdown Dial</span>
                </div>
              ) : (
                <div className="relative w-full" style={{ height: `${heightPx}px` }}>
                  <div
                    className="absolute inset-0 rounded-full"
                    style={{ backgroundColor: trackColor }}
                  />
                  <div
                    className="absolute left-0 top-0 h-full rounded-full"
                    style={{
                      width: `${previewProgress * 100}%`,
                      background: type === "NEON_GRADIENT"
                        ? `linear-gradient(90deg, #00E5FF, ${fillColor}, #00FFA3)`
                        : fillColor,
                      boxShadow: glow || type === "NEON_GRADIENT"
                        ? `0 0 10px ${fillColor}`
                        : "none",
                    }}
                  />
                  {type === "NEON_GRADIENT" && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow-md shadow-white"
                      style={{ left: `${previewProgress * 100}%` }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center p-6 text-center text-xs text-white/40 border border-dashed border-white/10 rounded-lg">
          <span>Progress bar is disabled. Toggle above to activate.</span>
        </div>
      )}
    </div>
  );
}
