"use client";

/**
 * K04: the player toolbar (README recon §3 — Kalakar's player toolbar has a
 * Safe Zone on/off toggle, a Replace-media button and a resolution indicator;
 * ours had the safe-zone *logic* — `showSafeZones` on `CaptionStage`, default
 * `true` — with no toggle UI, and neither of the other two at all).
 *
 * A single slim row directly above the stage, so all three controls are
 * genuinely "near the player" rather than in a menu:
 * `[ 1080×1920 · 9:16 ]  …  [ Safe zone ⏻ ]  [ Replace media ]`.
 */
import * as React from "react";

import { Switch } from "@montaj/ui";

import { ReplaceMediaButton } from "./ReplaceMediaButton";

export interface PlayerToolbarCanvas {
  readonly width: number;
  readonly height: number;
  /** "9:16" | "16:9" | "1:1" | "4:5" (`packages/edg`'s `AspectSchema`) — the document's own geometry truth, not recomputed here. */
  readonly aspect: string;
}

export interface PlayerToolbarProps {
  readonly canvas: PlayerToolbarCanvas;
  readonly safeZonesOn: boolean;
  readonly onSafeZonesChange: (on: boolean) => void;
  readonly projectId: string;
  readonly mediaId: string | undefined;
  readonly className?: string;
}

export function PlayerToolbar({
  canvas,
  safeZonesOn,
  onSafeZonesChange,
  projectId,
  mediaId,
  className,
}: PlayerToolbarProps): React.JSX.Element {
  return (
    <div
      className={`flex w-full items-center gap-3 px-1 pb-2 text-xs ${className ?? ""}`}
      data-testid="player-toolbar"
    >
      <span
        className="text-fg-2 rounded-sm bg-white/5 px-2 py-1 font-medium tabular-nums"
        data-testid="resolution-indicator"
        title="This project's canvas — set when it was created, shown here for reference"
      >
        {canvas.width}×{canvas.height} · {canvas.aspect}
      </span>

      <span className="ml-auto flex items-center gap-3">
        <label className="text-fg-2 flex items-center gap-1.5" data-testid="safe-zone-toggle">
          Safe zone
          <Switch
            checked={safeZonesOn}
            onCheckedChange={onSafeZonesChange}
            aria-label="Safe zone overlay"
            data-testid="safe-zone-switch"
          />
        </label>

        <ReplaceMediaButton projectId={projectId} mediaId={mediaId} />
      </span>
    </div>
  );
}
