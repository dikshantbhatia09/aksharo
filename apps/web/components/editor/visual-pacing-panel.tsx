"use client";

import * as React from "react";
import { Badge, Button } from "@montaj/ui";

import type { ZoomPreset, ZoomTransition } from "../../lib/passes/client";

export interface VisualPacingPanelProps {
  /** Selected zoom pacing preset. Defaults to "standard". */
  readonly preset?: ZoomPreset;
  /** Selected transition style. Defaults to "ease". */
  readonly transition?: ZoomTransition;
  /** Callback fired when the pacing preset is changed. */
  readonly onPresetChange?: (preset: ZoomPreset) => void;
  /** Callback fired when the transition style is changed. */
  readonly onTransitionChange?: (transition: ZoomTransition) => void;
  /** Callback to trigger/apply the auto-zoom pass. */
  readonly onApply?: (preset: ZoomPreset, transition: ZoomTransition) => void | Promise<void>;
  /** Number of active zoom keyframes/events in the timeline. */
  readonly activeZoomCount?: number;
  /** True while the auto-zoom pass is computing/running. */
  readonly isApplying?: boolean;
  /** True to disable interactive controls (e.g. in local mode). */
  readonly disabled?: boolean;
  /** Optional container class name. */
  readonly className?: string;
}

export const PACING_PRESET_OPTIONS: readonly {
  readonly id: ZoomPreset;
  readonly label: string;
  readonly cadence: string;
  readonly description: string;
}[] = [
  { id: "off", label: "Off", cadence: "None", description: "Static camera without zoom punches" },
  { id: "subtle", label: "Subtle", cadence: "every 7s", description: "Subtle 1.15x punch on key emphasis moments" },
  { id: "standard", label: "Standard", cadence: "every 4s", description: "1.18x punch rhythm aligned with speech units" },
  { id: "fast", label: "Fast", cadence: "every 2.5s", description: "High-energy 1.25x punch for rapid-fire shorts" },
];

export const TRANSITION_OPTIONS: readonly {
  readonly id: ZoomTransition;
  readonly label: string;
  readonly icon: string;
}[] = [
  { id: "ease", label: "Smooth Ease", icon: "〜" },
  { id: "jump", label: "Jump Cut", icon: "⚡" },
  { id: "creep", label: "Ken Burns Creep", icon: "⇗" },
  { id: "alternate", label: "Rhythmic Alternation", icon: "⇄" },
];

/**
 * VisualPacingPanel (Pillar 6, Feature 03: Dynamic Auto-Zoom Pacing).
 *
 * Implements Submagic & AutoCut caliber visual pacing controls:
 * 1. Pacing Density segmented control: [Off | Subtle (7s) | Standard (4s) | Fast (2.5s)].
 * 2. Camera Motion Transition selector: [Smooth Ease | Jump Cut | Ken Burns Creep | Rhythmic Alternation].
 * 3. Face-Anchored Eye-Line Safe Zone guarantee indicator ($Y \in [0.28, 0.38]$).
 * 4. Real-time active zooms counter badge.
 */
export function VisualPacingPanel({
  preset = "standard",
  transition = "ease",
  onPresetChange,
  onTransitionChange,
  onApply,
  activeZoomCount = 0,
  isApplying = false,
  disabled = false,
  className,
}: VisualPacingPanelProps): React.JSX.Element {
  const [internalPreset, setInternalPreset] = React.useState<ZoomPreset>(preset);
  const [internalTransition, setInternalTransition] = React.useState<ZoomTransition>(transition);

  React.useEffect(() => {
    setInternalPreset(preset);
  }, [preset]);

  React.useEffect(() => {
    setInternalTransition(transition);
  }, [transition]);

  const handleSelectPreset = React.useCallback(
    (newPreset: ZoomPreset) => {
      setInternalPreset(newPreset);
      onPresetChange?.(newPreset);
    },
    [onPresetChange],
  );

  const handleSelectTransition = React.useCallback(
    (newTransition: ZoomTransition) => {
      setInternalTransition(newTransition);
      onTransitionChange?.(newTransition);
    },
    [onTransitionChange],
  );

  const selectedPresetObj =
    PACING_PRESET_OPTIONS.find((p) => p.id === internalPreset) ?? PACING_PRESET_OPTIONS[2]!;

  return (
    <div
      data-testid="visual-pacing-panel"
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
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>Dynamic Camera Zooms</span>
            <Badge tone="neutral" style={{ fontSize: 10, padding: "1px 6px" }}>
              Pillar 6 §03
            </Badge>
          </h4>
          <span style={{ fontSize: 12, color: "var(--muted-foreground, #64748b)" }}>
            Face-anchored punch-ins and rhythmic visual reset pacing
          </span>
        </div>

        {activeZoomCount > 0 ? (
          <Badge data-testid="zoom-count-badge" tone="accent">
            {activeZoomCount} dynamic {activeZoomCount === 1 ? "zoom" : "zooms"} active
          </Badge>
        ) : null}
      </div>

      {/* Pacing Density Segmented Control */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span style={{ fontWeight: 500 }}>Zoom Pacing Frequency:</span>
          <span
            data-testid="active-preset-cadence"
            style={{ fontWeight: 600, color: "var(--primary, #2563eb)", fontSize: 12 }}
          >
            {selectedPresetObj.cadence}
          </span>
        </div>

        <div
          role="radiogroup"
          aria-label="Zoom Pacing Frequency"
          data-testid="pacing-segmented-control"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 4,
            padding: 3,
            backgroundColor: "var(--muted, #f1f5f9)",
            borderRadius: 6,
          }}
        >
          {PACING_PRESET_OPTIONS.map((opt) => {
            const isSelected = internalPreset === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={disabled || isApplying}
                onClick={() => handleSelectPreset(opt.id)}
                data-testid={`pacing-option-${opt.id}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "6px 4px",
                  borderRadius: 4,
                  border: "none",
                  cursor: disabled || isApplying ? "not-allowed" : "pointer",
                  backgroundColor: isSelected ? "var(--background, #ffffff)" : "transparent",
                  color: isSelected ? "var(--foreground, #0f172a)" : "var(--muted-foreground, #64748b)",
                  boxShadow: isSelected ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  fontWeight: isSelected ? 600 : 400,
                  fontSize: 12,
                  transition: "all 0.15s ease",
                }}
              >
                <span>{opt.label}</span>
                <span style={{ fontSize: 10, opacity: 0.8 }}>{opt.cadence}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Camera Motion Style Transition */}
      {internalPreset !== "off" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Transition Style:</span>
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6 }}
            data-testid="transition-options-container"
          >
            {TRANSITION_OPTIONS.map((opt) => {
              const isSelected = internalTransition === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled || isApplying}
                  onClick={() => handleSelectTransition(opt.id)}
                  data-testid={`transition-option-${opt.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: isSelected
                      ? "1px solid var(--primary, #2563eb)"
                      : "1px solid var(--border, #e2e8f0)",
                    backgroundColor: isSelected
                      ? "var(--primary-subtle, #eff6ff)"
                      : "var(--background, #ffffff)",
                    color: isSelected ? "var(--primary, #2563eb)" : "var(--foreground, #0f172a)",
                    cursor: disabled || isApplying ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 400,
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: 13 }}>{opt.icon}</span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Face Anchor Safety Indicator */}
      <div
        data-testid="face-anchor-indicator"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderRadius: 6,
          backgroundColor: "var(--accent-subtle, #f0fdf4)",
          border: "1px solid var(--accent-border, #bbf7d0)",
          fontSize: 11,
          color: "var(--accent-foreground, #15803d)",
        }}
      >
        <span style={{ fontSize: 14 }}>◎</span>
        <span>
          <strong>Face Anchor Active:</strong> Eye-line maintained in upper-third grid ($Y \in
          [0.28, 0.38]$) without forehead clipping.
        </span>
      </div>

      {/* Apply / Trigger Action */}
      {onApply ? (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <Button
            type="button"
            size="sm"
            disabled={disabled || isApplying}
            onClick={() => void onApply(internalPreset, internalTransition)}
            data-testid="apply-zoom-pacing-button"
            style={{ fontSize: 12, height: 28 }}
          >
            {isApplying ? "Analyzing & Applying Zooms…" : "Apply Auto-Zoom"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
