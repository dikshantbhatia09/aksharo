"use client";

import * as React from "react";

import { Input, cn } from "@montaj/ui";

export const DURATION_BINS = {
  UNDER_30: { minSec: 15, maxSec: 30, label: "< 30s (Rapid Loops)" },
  BETWEEN_30_60: { minSec: 30, maxSec: 60, label: "30s–60s (Shorts & Reels)" },
  BETWEEN_60_90: { minSec: 60, maxSec: 90, label: "60s–90s (TikTok Monetization)" },
  BETWEEN_90_180: { minSec: 90, maxSec: 180, label: "90s–3m (Deep Dives & LinkedIn)" },
  AUTO: { minSec: 20, maxSec: 90, label: "AI Recommended" },
} as const;

export type DurationBinPresetKey = keyof typeof DURATION_BINS;
export type DurationBinSelection = DurationBinPresetKey | "CUSTOM";

export const DURATION_PICKER_ORDER: readonly DurationBinPresetKey[] = [
  "UNDER_30",
  "BETWEEN_30_60",
  "BETWEEN_60_90",
  "BETWEEN_90_180",
  "AUTO",
];

export interface DurationPickerProps {
  readonly value: DurationBinSelection;
  readonly onChange: (
    bin: DurationBinSelection,
    bounds: { readonly minSec: number; readonly maxSec: number },
  ) => void;
  readonly customMinSec?: number;
  readonly customMaxSec?: number;
  readonly onCustomChange?: (minSec: number, maxSec: number) => void;
  readonly className?: string;
}

export function validateCustomDuration(minSec: number, maxSec: number): string | null {
  if (!Number.isFinite(minSec) || !Number.isFinite(maxSec)) {
    return "Enter valid numeric durations in seconds.";
  }
  if (minSec <= 0) {
    return "Minimum duration must be greater than 0s.";
  }
  if (maxSec > 300) {
    return "Maximum duration cannot exceed 300s (5 minutes).";
  }
  if (minSec >= maxSec) {
    return "Maximum duration must be strictly greater than minimum duration.";
  }
  return null;
}

export function DurationPicker({
  value,
  onChange,
  customMinSec = 45,
  customMaxSec = 75,
  onCustomChange,
  className,
}: DurationPickerProps): React.ReactElement {
  const [minInput, setMinInput] = React.useState<string>(String(customMinSec));
  const [maxInput, setMaxInput] = React.useState<string>(String(customMaxSec));

  React.useEffect(() => {
    setMinInput(String(customMinSec));
  }, [customMinSec]);

  React.useEffect(() => {
    setMaxInput(String(customMaxSec));
  }, [customMaxSec]);

  const parsedMin = Number(minInput);
  const parsedMax = Number(maxInput);
  const customError =
    value === "CUSTOM" ? validateCustomDuration(parsedMin, parsedMax) : null;

  const activeBounds =
    value === "CUSTOM"
      ? {
          minSec: Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : 45,
          maxSec: Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 75,
        }
      : DURATION_BINS[value];

  const isTikTokEligible = activeBounds.minSec >= 60;
  const isBelowTikTokThreshold = activeBounds.maxSec <= 60 && value !== "AUTO";

  return (
    <div className={cn("flex flex-col gap-2.5", className)} data-testid="duration-picker">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Target clip duration">
        {DURATION_PICKER_ORDER.map((binKey) => {
          const bin = DURATION_BINS[binKey];
          const selected = value === binKey;
          const eligibleForTikTok = bin.minSec >= 60;

          return (
            <button
              key={binKey}
              type="button"
              aria-pressed={selected}
              data-testid={`duration-chip-${binKey}`}
              onClick={() => {
                onChange(binKey, { minSec: bin.minSec, maxSec: bin.maxSec });
              }}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium transition-colors",
                selected
                  ? "border-accent bg-bg-2 text-fg-0 ring-1 ring-accent"
                  : "border-border bg-bg-1 text-fg-1 hover:border-neutral-600",
              )}
            >
              <span>{bin.label}</span>
              {eligibleForTikTok && (
                <span
                  data-testid={`tiktok-badge-${binKey}`}
                  className="rounded-xs bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400"
                >
                  TikTok Monetization Eligible
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          aria-pressed={value === "CUSTOM"}
          data-testid="duration-chip-CUSTOM"
          onClick={() => {
            const safeMin = Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : 45;
            const safeMax =
              Number.isFinite(parsedMax) && parsedMax > safeMin && parsedMax <= 300
                ? parsedMax
                : 75;
            onChange("CUSTOM", { minSec: safeMin, maxSec: safeMax });
          }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-xs font-medium transition-colors",
            value === "CUSTOM"
              ? "border-accent bg-bg-2 text-fg-0 ring-1 ring-accent"
              : "border-border bg-bg-1 text-fg-1 hover:border-neutral-600",
          )}
        >
          <span>Custom Range</span>
        </button>
      </div>

      {value === "CUSTOM" && (
        <div
          className="flex flex-wrap items-center gap-3 pt-1"
          data-testid="custom-duration-controls"
        >
          <label className="flex items-center gap-1.5 text-xs text-fg-1">
            <span>Min (s)</span>
            <Input
              type="number"
              min={3}
              max={299}
              value={minInput}
              data-testid="custom-duration-min"
              className="w-20 bg-sunken text-xs"
              onChange={(event) => {
                const nextMinText = event.target.value;
                setMinInput(nextMinText);
                const nextMin = Number(nextMinText);
                if (validateCustomDuration(nextMin, parsedMax) === null) {
                  onCustomChange?.(nextMin, parsedMax);
                  onChange("CUSTOM", { minSec: nextMin, maxSec: parsedMax });
                }
              }}
            />
          </label>
          <span className="text-xs text-fg-2">to</span>
          <label className="flex items-center gap-1.5 text-xs text-fg-1">
            <span>Max (s)</span>
            <Input
              type="number"
              min={4}
              max={300}
              value={maxInput}
              data-testid="custom-duration-max"
              className="w-20 bg-sunken text-xs"
              onChange={(event) => {
                const nextMaxText = event.target.value;
                setMaxInput(nextMaxText);
                const nextMax = Number(nextMaxText);
                if (validateCustomDuration(parsedMin, nextMax) === null) {
                  onCustomChange?.(parsedMin, nextMax);
                  onChange("CUSTOM", { minSec: parsedMin, maxSec: nextMax });
                }
              }}
            />
          </label>
          {customError !== null && (
            <p
              role="alert"
              data-testid="custom-duration-error"
              className="w-full text-xs text-rejected"
            >
              {customError}
            </p>
          )}
        </div>
      )}

      {isTikTokEligible && (
        <p
          data-testid="tiktok-monetization-eligible-banner"
          className="text-xs font-medium text-emerald-400"
        >
          TikTok Monetization Eligible: All generated clips are &ge; 60s and qualify for TikTok Creator Rewards.
        </p>
      )}

      {isBelowTikTokThreshold && (
        <p
          data-testid="tiktok-monetization-warning"
          className="text-xs text-amber-400"
        >
          Clips &lt; 60s are not eligible for TikTok Rewards. Select 60s–90s or 90s–3m for CPM monetization.
        </p>
      )}
    </div>
  );
}

