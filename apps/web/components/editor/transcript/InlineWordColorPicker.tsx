"use client";

import React, { useEffect, useRef, useState } from "react";

export interface InlineWordColorPickerProps {
  readonly currentColor?: string | null;
  readonly paletteAccents?: readonly string[];
  readonly onSelectColor: (color: string | null) => void;
  readonly onClose: () => void;
}

export interface ColorSwatch {
  color: string;
  label: string;
  tier: number;
}

export const PRESET_SWATCHES: readonly ColorSwatch[] = [
  { color: "#FFFFFF", label: "White (Default)", tier: 0 },
  { color: "#FFF000", label: "Neon Yellow (Metrics)", tier: 1 },
  { color: "#00FF66", label: "Cyber Green (Impact)", tier: 3 },
  { color: "#00E5FF", label: "Electric Cyan (Entities)", tier: 2 },
  { color: "#FF007F", label: "Hot Pink (Emphasis)", tier: 4 },
  { color: "#FFB800", label: "Gold (Highlight)", tier: 5 },
];

export function InlineWordColorPicker({
  currentColor,
  paletteAccents,
  onSelectColor,
  onClose,
}: InlineWordColorPickerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [customHex, setCustomHex] = useState(currentColor ?? "");

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }

    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const activeColorNorm = currentColor?.toUpperCase();

  // Combine default presets with any style-specific palette accents
  const swatches = React.useMemo(() => {
    const list = [...PRESET_SWATCHES];
    if (paletteAccents && paletteAccents.length > 0) {
      for (const accent of paletteAccents) {
        if (!list.some((s) => s.color.toUpperCase() === accent.toUpperCase())) {
          list.push({ color: accent, label: "Brand Accent", tier: 9 });
        }
      }
    }
    return list;
  }, [paletteAccents]);

  const handleApplyCustom = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = customHex.trim();
    if (/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
      onSelectColor(trimmed);
      onClose();
    }
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Keyword Highlight Color Picker"
      data-testid="inline-word-color-picker"
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 rounded-xl border border-neutral-800 bg-neutral-900/95 p-2 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 pb-2 border-b border-neutral-800">
        <span className="text-[11px] font-medium text-neutral-300">Highlight Color</span>
        <button
          type="button"
          data-testid="color-picker-reset"
          onClick={() => {
            onSelectColor(null);
            onClose();
          }}
          className="ml-auto px-1.5 py-0.5 text-[10px] font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Color Swatch Bubbles */}
      <div className="flex items-center gap-1.5 pt-2 pb-1.5 px-0.5">
        {swatches.map((swatch) => {
          const isSelected = activeColorNorm === swatch.color.toUpperCase();
          return (
            <button
              key={swatch.color}
              type="button"
              data-testid={`color-swatch-${swatch.color}`}
              aria-label={swatch.label}
              title={swatch.label}
              onClick={() => {
                onSelectColor(swatch.color === "#FFFFFF" ? null : swatch.color);
                onClose();
              }}
              style={{ backgroundColor: swatch.color }}
              className={`h-6 w-6 rounded-full border border-black/40 transition-transform hover:scale-110 active:scale-95 shadow-sm ${
                isSelected ? "ring-2 ring-white ring-offset-2 ring-offset-neutral-900 scale-105" : ""
              }`}
            />
          );
        })}
      </div>

      {/* Hex Code Input */}
      <form onSubmit={handleApplyCustom} className="flex items-center gap-1 pt-1">
        <input
          type="text"
          placeholder="#RRGGBB"
          value={customHex}
          onChange={(e) => setCustomHex(e.target.value)}
          data-testid="color-picker-hex-input"
          className="w-20 bg-neutral-800/80 rounded px-1.5 py-0.5 text-[11px] font-mono text-neutral-100 placeholder-neutral-500 outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          data-testid="color-picker-hex-apply"
          className="px-2 py-0.5 text-[10px] font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded transition-colors"
        >
          Apply
        </button>
      </form>
    </div>
  );
}
