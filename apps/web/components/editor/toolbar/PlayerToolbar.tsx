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
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";

import type { SafeZonePlatform } from "@montaj/caption-styles";
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
  readonly safeZonePlatform?: SafeZonePlatform;
  readonly onSafeZonePlatformChange?: (platform: SafeZonePlatform) => void;
  readonly projectId: string;
  readonly mediaId: string | undefined;
  readonly className?: string;
}

const PILL =
  "flex h-8 items-center gap-1.5 rounded-full bg-overlay px-3 text-xs text-fg-0 backdrop-blur-[6px] transition-colors duration-[160ms] hover:bg-ink/90";

const PLATFORMS: readonly { readonly id: SafeZonePlatform; readonly label: string }[] = [
  { id: "tiktok", label: "TikTok" },
  { id: "reels", label: "Instagram Reels" },
  { id: "shorts", label: "YouTube Shorts" },
  { id: "universal", label: "Universal Safe Box" },
];

export function PlayerToolbar({
  canvas,
  safeZonesOn,
  onSafeZonesChange,
  safeZonePlatform = "tiktok",
  onSafeZonePlatformChange,
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
          <DropdownMenuContent align="end" className="w-52 p-3">
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Show safe zone</span>
              <Switch
                checked={safeZonesOn}
                onCheckedChange={onSafeZonesChange}
                aria-label="Safe zone overlay"
                data-testid="safe-zone-switch"
              />
            </label>

            <div className="mt-3 border-t border-border/60 pt-2.5">
              <span className="mb-1.5 block text-[10px] font-semibold tracking-wider text-fg-2 uppercase">
                Simulator Overlay
              </span>
              <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Platform overlay">
                {PLATFORMS.map((item) => {
                  const active = safeZonePlatform === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        "flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-left transition-colors",
                        active
                          ? "bg-accent/15 font-medium text-accent"
                          : "text-fg-1 hover:bg-bg-2 hover:text-fg-0",
                      )}
                      onClick={() => {
                        onSafeZonePlatformChange?.(item.id);
                        if (!safeZonesOn) onSafeZonesChange(true);
                      }}
                      data-testid={`safe-zone-platform-${item.id}`}
                    >
                      <span>{item.label}</span>
                      {active ? <Check className="size-3 text-accent" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
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
