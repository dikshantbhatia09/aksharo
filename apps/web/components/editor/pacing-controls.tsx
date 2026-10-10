"use client";

import * as React from "react";
import { Badge, Button } from "@montaj/ui";

export interface PacingControlsProps {
  /**
   * Silence threshold in seconds (0.2s - 1.0s).
   * Pauses longer than this threshold are compressed down to 0.25s natural breathing pauses.
   */
  readonly thresholdSeconds?: number;
  /**
   * Callback when threshold changes.
   */
  readonly onChangeThreshold?: (threshold: number) => void;
  /**
   * Dead air seconds trimmed by the engine (e.g. 14.2).
   */
  readonly timeSavedSeconds?: number;
  /**
   * Callback to trigger silence trimming / autocut pass.
   */
  readonly onApply?: (thresholdSeconds: number) => void | Promise<void>;
  /**
   * True while trimming pass is running.
   */
  readonly isApplying?: boolean;
  /**
   * Disables interactive controls.
   */
  readonly disabled?: boolean;
  /**
   * Additional CSS class name.
   */
  readonly className?: string;
}

const PRESET_THRESHOLDS = [0.3, 0.5, 0.8] as const;

/**
 * PacingControls (Pillar 5, Functionality 03: Silence & Dead-Air Trimming).
 *
 * Provides:
 * 1. Adjustable Silence Sensitivity Slider (0.2s - 1.0s).
 * 2. Quick preset buttons: [0.3s | 0.5s | 0.8s].
 * 3. Time saved badge: "Trimmed X.Xs of dead air!".
 * 4. Preservation indicator: 0.25s natural breathing room tone preserved.
 */
export function PacingControls({
  thresholdSeconds = 0.4,
  onChangeThreshold,
  timeSavedSeconds = 0,
  onApply,
  isApplying = false,
  disabled = false,
  className,
}: PacingControlsProps): React.JSX.Element {
  const [internalThreshold, setInternalThreshold] = React.useState(thresholdSeconds);

  React.useEffect(() => {
    setInternalThreshold(thresholdSeconds);
  }, [thresholdSeconds]);

  const handleSliderChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number.parseFloat(e.target.value);
      setInternalThreshold(val);
      onChangeThreshold?.(val);
    },
    [onChangeThreshold],
  );

  const handleSelectPreset = React.useCallback(
    (val: number) => {
      setInternalThreshold(val);
      onChangeThreshold?.(val);
    },
    [onChangeThreshold],
  );

  return (
    <div
      data-testid="pacing-controls"
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 8,
        border: "1px solid var(--border, #e2e8f0)",
        backgroundColor: "var(--background-subtle, #f8fafc)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h4
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: "var(--foreground, #0f172a)",
            }}
          >
            Dead-Air & Silence Trimming
          </h4>
          <span style={{ fontSize: 12, color: "var(--muted-foreground, #64748b)" }}>
            Compresses long pauses down to natural 0.25s breath pauses
          </span>
        </div>

        {timeSavedSeconds > 0 ? (
          <Badge data-testid="time-saved-badge" tone="accent">
            Trimmed {timeSavedSeconds.toFixed(1)}s of dead air!
          </Badge>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <label htmlFor="silence-threshold-slider" style={{ fontWeight: 500 }}>
            Silence threshold:
          </label>
          <span data-testid="threshold-value-display" style={{ fontWeight: 600, fontFamily: "monospace" }}>
            {internalThreshold.toFixed(2)}s
          </span>
        </div>

        <input
          id="silence-threshold-slider"
          data-testid="silence-threshold-slider"
          type="range"
          min={0.2}
          max={1.0}
          step={0.05}
          value={internalThreshold}
          disabled={disabled || isApplying}
          onChange={handleSliderChange}
          style={{ width: "100%", cursor: disabled || isApplying ? "not-allowed" : "pointer" }}
          aria-label="Silence threshold slider"
        />

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted-foreground, #64748b)" }}>
          <span>0.2s (Fast pacing)</span>
          <span>1.0s (Relaxed pacing)</span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--muted-foreground, #64748b)" }}>Presets:</span>
        {PRESET_THRESHOLDS.map((presetVal) => {
          const isSelected = Math.abs(internalThreshold - presetVal) < 0.02;
          return (
            <Button
              key={presetVal}
              type="button"
              size="sm"
              variant={isSelected ? "primary" : "outline"}
              disabled={disabled || isApplying}
              onClick={() => handleSelectPreset(presetVal)}
              data-testid={`preset-${presetVal.toString().replace(".", "-")}`}
              style={{ fontSize: 12, padding: "2px 10px", height: 26 }}
            >
              {presetVal.toFixed(1)}s
            </Button>
          );
        })}

        {onApply ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || isApplying}
            onClick={() => void onApply(internalThreshold)}
            data-testid="apply-pacing-button"
            style={{ marginLeft: "auto", fontSize: 12, height: 28 }}
          >
            {isApplying ? "Trimming…" : "Trim Dead Air"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
