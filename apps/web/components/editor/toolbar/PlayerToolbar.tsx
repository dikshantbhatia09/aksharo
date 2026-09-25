"use client";

/**
 * K04: the player toolbar (README recon §3 — Kalakar's player toolbar has a
 * Safe Zone on/off toggle, a Replace-media button and a resolution indicator).
 *
 * Originally a slim row *above* the stage; corrected (2026-09-12, pixel-
 * sampled from the Kalakar reference export) to float directly over the
 * video itself as two frosted-glass pill groups — Replace top-left, Safe
 * zone + a resolution pill top-right — matching `rgba(20,20,22,.72)` +
 * `backdrop-filter:blur(6px)` exactly. The parent (`editor-client.tsx`'s
 * `data-testid="editor-stage-box"`) is already `position:relative`, so this
 * renders as an absolutely-positioned overlay filling it.
 *
 * The reference's "Safe zone" pill shows a caret-down, implying a dropdown
 * of presets this app has no spec for — rather than invent options nobody
 * asked for, this keeps the real, working boolean toggle (`Switch`), just
 * small enough to sit inside the same pill shape instead of a caret.
 */
import { ChevronDown } from "lucide-react";
import * as React from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, Switch } from "@montaj/ui";

import { ReplaceMediaButton } from "./ReplaceMediaButton";

import { cn } from "@/lib/utils";

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

const PILL =
  "flex h-8 items-center gap-1.5 rounded-full bg-overlay px-3 text-xs text-fg-0 backdrop-blur-[6px] transition-colors duration-[160ms] hover:bg-ink/90";

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
      className={cn("pointer-events-none absolute inset-0", className)}
      data-testid="player-toolbar"
    >
      <div className="pointer-events-auto absolute top-4 left-4">
        <ReplaceMediaButton projectId={projectId} mediaId={mediaId} className={PILL} />
      </div>

      <div className="pointer-events-auto absolute top-4 right-4 flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={PILL}
              data-testid="safe-zone-toggle"
              aria-label="Safe zone settings"
            >
              <span>Safe zone</span>
              <ChevronDown className="size-[11px] text-fg-2" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-3">
            <label className="flex items-center gap-3 text-xs">
              Show safe zone
              <Switch
                checked={safeZonesOn}
                onCheckedChange={onSafeZonesChange}
                aria-label="Safe zone overlay"
                data-testid="safe-zone-switch"
              />
            </label>
          </DropdownMenuContent>
        </DropdownMenu>

        <span
          className={PILL}
          data-testid="resolution-indicator"
          title={`${String(canvas.width)}×${String(canvas.height)} · ${canvas.aspect}`}
        >
          {/* Shirorekha pass: the pill used to read "Res" beside a gold dot,
              with the real geometry only in an sr-only span. A label that
              names nothing is not a label (HIG › Writing), so the pill now
              shows the geometry itself. */}
          <span className="font-mono tabular-nums">
            {canvas.width}×{canvas.height} · {canvas.aspect}
          </span>
        </span>
      </div>
    </div>
  );
}
