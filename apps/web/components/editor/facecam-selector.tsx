"use client";

/**
 * Pillar 3 §07: Streamer Gameplay & Facecam Split Selector UI
 *
 * Provides:
 * 1. Interactive 1-click corner preset selectors [Top-Left | Top-Right | Bottom-Left | Bottom-Right]
 *    plus manual precision slider/drag bounds for the webcam overlay box.
 * 2. Neon gamer border separator color picker [Twitch Purple | Neon Green | Cyber Cyan | Flame Red].
 * 3. Split-screen live preview telemetry displaying the Top 35% webcam pane (1080 x 672)
 *    and Bottom 65% action gameplay pane (1080 x 1248).
 * 4. Auto-detect trigger and reset-to-defaults capabilities.
 */

import React, { useCallback, useMemo, useState } from "react";

export interface NormalizedCropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelCropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StreamerSplitLayoutTelemetry {
  readonly facecamCrop: PixelCropBox;
  readonly gameplayCrop: PixelCropBox;
  readonly topPaneHeight: number;
  readonly bottomPaneHeight: number;
  readonly dividerColor: string;
}

export type CornerPreset = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNER_PRESETS: Record<CornerPreset, NormalizedCropBox> = {
  "top-left": { x: 0.04, y: 0.05, width: 0.25, height: 0.30 },
  "top-right": { x: 0.71, y: 0.05, width: 0.25, height: 0.30 },
  "bottom-left": { x: 0.04, y: 0.65, width: 0.25, height: 0.30 },
  "bottom-right": { x: 0.71, y: 0.65, width: 0.25, height: 0.30 },
};

export const DEFAULT_STREAMER_COLORS = [
  { id: "twitch-purple", name: "Twitch Purple", hex: "#8B5CF6" },
  { id: "neon-green", name: "Neon Green", hex: "#00FFA3" },
  { id: "cyber-cyan", name: "Cyber Cyan", hex: "#06B6D4" },
  { id: "flame-red", name: "Flame Red", hex: "#EF4444" },
] as const;

export function computeStreamerSplitCrops(
  sourceWidth: number,
  sourceHeight: number,
  facecamBox: NormalizedCropBox,
  canvasWidth: number = 1080,
  canvasHeight: number = 1920,
): {
  facecamCrop: PixelCropBox;
  gameplayCrop: PixelCropBox;
  topPaneHeight: number;
  bottomPaneHeight: number;
} {
  const topPaneHeight = Math.round(canvasHeight * 0.35); // 672
  const bottomPaneHeight = canvasHeight - topPaneHeight; // 1248

  // Centered gameplay crop for bottom 65% pane
  const gameplayAspect = canvasWidth / Math.max(1, bottomPaneHeight);
  const gameH = Math.floor(sourceHeight / 2) * 2;
  const gameW = Math.min(
    Math.floor(sourceWidth / 2) * 2,
    Math.round((gameH * gameplayAspect) / 2) * 2,
  );
  const gameX = Math.floor(Math.max(0, sourceWidth - gameW) / 4) * 2;
  const gameplayCrop: PixelCropBox = { x: gameX, y: 0, width: gameW, height: gameH };

  // Facecam crop from normalized coordinates
  const camX = Math.floor((Math.max(0, Math.min(1 - facecamBox.width, facecamBox.x)) * sourceWidth) / 2) * 2;
  const camY = Math.floor((Math.max(0, Math.min(1 - facecamBox.height, facecamBox.y)) * sourceHeight) / 2) * 2;
  const camW = Math.floor((Math.min(1, facecamBox.width) * sourceWidth) / 2) * 2;
  const camH = Math.floor((Math.min(1, facecamBox.height) * sourceHeight) / 2) * 2;

  const facecamCrop: PixelCropBox = {
    x: camX,
    y: camY,
    width: Math.max(32, camW),
    height: Math.max(32, camH),
  };

  return {
    facecamCrop,
    gameplayCrop,
    topPaneHeight,
    bottomPaneHeight,
  };
}

export interface FacecamSelectorProps {
  /** Source video dimensions (default 1920 x 1080). */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  /** Initial or detected facecam box. */
  readonly initialFacecamBox?: NormalizedCropBox;
  /** Initial border divider color (default: `#8B5CF6`). */
  readonly initialDividerColor?: string;
  /** Callback fired when creator adjusts facecam bounding box or colors. */
  readonly onChange?: (telemetry: StreamerSplitLayoutTelemetry) => void;
  /** Callback fired when creator clicks Auto-Detect facecam. */
  readonly onAutoDetect?: () => void;
  /** Disabled during processing/render. */
  readonly disabled?: boolean;
}

export function FacecamSelector({
  sourceWidth = 1920,
  sourceHeight = 1080,
  initialFacecamBox = CORNER_PRESETS["bottom-right"],
  initialDividerColor = "#8B5CF6",
  onChange,
  onAutoDetect,
  disabled = false,
}: FacecamSelectorProps): React.JSX.Element {
  const [facecamBox, setFacecamBox] = useState<NormalizedCropBox>(initialFacecamBox);
  const [dividerColor, setDividerColor] = useState<string>(initialDividerColor);
  const [selectedCorner, setSelectedCorner] = useState<CornerPreset | "custom">("bottom-right");

  const telemetry = useMemo(() => {
    const crops = computeStreamerSplitCrops(sourceWidth, sourceHeight, facecamBox);
    return {
      ...crops,
      dividerColor,
    };
  }, [sourceWidth, sourceHeight, facecamBox, dividerColor]);

  const updateFacecam = useCallback(
    (nextBox: NormalizedCropBox, corner: CornerPreset | "custom") => {
      setFacecamBox(nextBox);
      setSelectedCorner(corner);
      if (onChange) {
        const crops = computeStreamerSplitCrops(sourceWidth, sourceHeight, nextBox);
        onChange({ ...crops, dividerColor });
      }
    },
    [sourceWidth, sourceHeight, dividerColor, onChange],
  );

  const handleCornerSelect = useCallback(
    (preset: CornerPreset) => {
      updateFacecam(CORNER_PRESETS[preset], preset);
    },
    [updateFacecam],
  );

  const handleColorSelect = useCallback(
    (hex: string) => {
      setDividerColor(hex);
      if (onChange) {
        onChange({ ...telemetry, dividerColor: hex });
      }
    },
    [telemetry, onChange],
  );

  const handleReset = useCallback(() => {
    updateFacecam(CORNER_PRESETS["bottom-right"], "bottom-right");
    setDividerColor("#8B5CF6");
  }, [updateFacecam]);

  return (
    <div
      data-testid="facecam-selector"
      className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-zinc-100 shadow-2xl"
    >
      {/* Header & Auto-Detect */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-wide text-zinc-200">
            Streamer Layout (Facecam & Gameplay Split)
          </h3>
          <p className="text-xs text-zinc-400">
            Top 35% Streamer Facecam · Bottom 65% Gameplay · Neon Gamer Divider
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onAutoDetect ? (
            <button
              type="button"
              data-testid="auto-detect-btn"
              disabled={disabled}
              onClick={onAutoDetect}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              Auto-Detect Facecam
            </button>
          ) : null}
          <button
            type="button"
            data-testid="reset-facecam-btn"
            disabled={disabled}
            onClick={handleReset}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
          >
            Reset
          </button>
        </div>
      </div>

      {/* 1-Click Corner Presets */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-300">Facecam Corner Preset:</span>
        <div className="grid grid-cols-4 gap-2" role="group" aria-label="Corner Presets">
          {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((corner) => {
            const isActive = selectedCorner === corner;
            const labels: Record<CornerPreset, string> = {
              "top-left": "Top Left",
              "top-right": "Top Right",
              "bottom-left": "Bottom Left",
              "bottom-right": "Bottom Right",
            };
            return (
              <button
                key={corner}
                type="button"
                data-testid={`corner-preset-${corner}`}
                data-active={isActive ? "true" : "false"}
                disabled={disabled}
                onClick={() => handleCornerSelect(corner)}
                className={`rounded-lg border px-2.5 py-2 text-xs font-medium transition-all ${
                  isActive
                    ? "border-indigo-500 bg-indigo-950/60 text-white ring-1 ring-indigo-500"
                    : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
                }`}
              >
                {labels[corner]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Neon Gamer Separator Color */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-300">Neon Separator Border:</span>
        <div className="flex items-center gap-2">
          {DEFAULT_STREAMER_COLORS.map((col) => {
            const isSelected = dividerColor.toLowerCase() === col.hex.toLowerCase();
            return (
              <button
                key={col.id}
                type="button"
                data-testid={`color-preset-${col.id}`}
                data-selected={isSelected ? "true" : "false"}
                disabled={disabled}
                onClick={() => handleColorSelect(col.hex)}
                style={{ backgroundColor: col.hex }}
                className={`h-7 w-7 rounded-full border-2 transition-transform ${
                  isSelected ? "scale-110 border-white shadow-lg" : "border-transparent opacity-80 hover:opacity-100"
                }`}
                title={col.name}
              />
            );
          })}
          <div className="ml-2 flex items-center gap-1.5 text-xs text-zinc-400">
            <span>Color:</span>
            <input
              type="text"
              data-testid="custom-color-input"
              value={dividerColor}
              disabled={disabled}
              onChange={(e) => handleColorSelect(e.target.value)}
              className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs font-mono text-zinc-200"
            />
          </div>
        </div>
      </div>

      {/* Interactive Video Preview Box Visualization */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-zinc-300">16:9 Source Video Overlay Preview:</span>
        <div
          data-testid="interactive-source-preview"
          className="relative aspect-video w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
        >
          {/* Central Gameplay Crop Boundary Guideline */}
          <div
            data-testid="gameplay-guideline"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${(telemetry.gameplayCrop.x / sourceWidth) * 100}%`,
              width: `${(telemetry.gameplayCrop.width / sourceWidth) * 100}%`,
              borderLeft: "1px dashed rgba(255, 255, 255, 0.25)",
              borderRight: "1px dashed rgba(255, 255, 255, 0.25)",
              backgroundColor: "rgba(255, 255, 255, 0.03)",
              pointerEvents: "none",
            }}
          >
            <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-mono text-zinc-400">
              Gameplay Focal Area (65%)
            </div>
          </div>

          {/* Interactive Facecam Crop Box */}
          <div
            data-testid="facecam-crop-box"
            style={{
              position: "absolute",
              left: `${facecamBox.x * 100}%`,
              top: `${facecamBox.y * 100}%`,
              width: `${facecamBox.width * 100}%`,
              height: `${facecamBox.height * 100}%`,
              border: `2px solid ${dividerColor}`,
              boxShadow: `0 0 10px ${dividerColor}88`,
              backgroundColor: "rgba(139, 92, 246, 0.15)",
            }}
            className="flex items-center justify-center rounded cursor-move select-none"
          >
            <span
              style={{ color: dividerColor }}
              className="text-[10px] font-bold tracking-wider uppercase"
            >
              Facecam (35%)
            </span>
          </div>
        </div>
      </div>

      {/* Manual Fine-Tuning Sliders */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-zinc-400">Position X ({Math.round(facecamBox.x * 100)}%):</span>
          <input
            type="range"
            min="0"
            max="0.75"
            step="0.01"
            value={facecamBox.x}
            disabled={disabled}
            data-testid="slider-pos-x"
            onChange={(e) =>
              updateFacecam({ ...facecamBox, x: Number.parseFloat(e.target.value) }, "custom")
            }
            className="accent-indigo-500"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-zinc-400">Position Y ({Math.round(facecamBox.y * 100)}%):</span>
          <input
            type="range"
            min="0"
            max="0.70"
            step="0.01"
            value={facecamBox.y}
            disabled={disabled}
            data-testid="slider-pos-y"
            onChange={(e) =>
              updateFacecam({ ...facecamBox, y: Number.parseFloat(e.target.value) }, "custom")
            }
            className="accent-indigo-500"
          />
        </label>
      </div>

      {/* Live Telemetry Bar */}
      <div
        data-testid="streamer-telemetry"
        className="flex items-center justify-between rounded bg-zinc-900/80 px-3 py-2 text-[11px] font-mono text-zinc-400 border border-zinc-800"
      >
        <div>
          Webcam: {telemetry.facecamCrop.width}×{telemetry.facecamCrop.height} at ({telemetry.facecamCrop.x}, {telemetry.facecamCrop.y})
        </div>
        <div>
          Gameplay: {telemetry.gameplayCrop.width}×{telemetry.gameplayCrop.height} at ({telemetry.gameplayCrop.x}, 0)
        </div>
      </div>
    </div>
  );
}
