"use client";

import * as React from "react";
import type { SafeZonePlatform } from "@montaj/caption-styles";
import { cn } from "@/lib/utils";

export interface StageFit {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface SafeZoneOverlayProps {
  readonly fit: StageFit;
  readonly canvas: { readonly width: number; readonly height: number };
  /** Target platform preset to simulate, or 'none' to hide overlay. */
  readonly platform?: SafeZonePlatform | "none";
  /** Whether to draw the dashed exclusion guide boundaries (default true). */
  readonly showGuides?: boolean;
  /** Whether to draw simulated platform buttons and chrome wireframe (default true). */
  readonly showChrome?: boolean;
  /** Optional active magnetic snap notification message (e.g. "Snapped to TikTok safe zone"). */
  readonly snapTooltip?: string;
  readonly className?: string;
}

/**
 * Social Media Safe-Zone & UI Avoidance Simulator (Pillar 3 §08 Step 2).
 *
 * Renders pure SVG wireframes replicating active mobile platform UI layouts
 * (TikTok, Instagram Reels, YouTube Shorts, or Universal Safe Box) on 9:16 canvases
 * with zero render latency.
 */
export function SafeZoneOverlay({
  fit,
  canvas,
  platform = "universal",
  showGuides = true,
  showChrome = true,
  snapTooltip,
  className,
}: SafeZoneOverlayProps): React.JSX.Element | null {
  if (platform === "none") return null;

  const isVertical = canvas.height > canvas.width;
  // If video is not vertical (e.g. 16:9 landscape), only show minimal guides
  const activePlatform = isVertical ? platform : "universal";

  return (
    <div
      className={cn(
        "pointer-events-none absolute select-none overflow-hidden transition-opacity duration-150",
        className,
      )}
      style={{
        left: fit.left,
        top: fit.top,
        width: fit.width,
        height: fit.height,
      }}
      data-testid="safe-zone-overlay"
      data-platform={activePlatform}
    >
      <svg
        viewBox="0 0 1080 1920"
        className="h-full w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="topExclusionGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="bottomExclusionGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.18" />
          </linearGradient>
          <linearGradient id="rightExclusionGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.18" />
          </linearGradient>
        </defs>

        {/* 1. Safe Guides Layer */}
        {showGuides ? (
          <g data-testid="safe-zone-guides" opacity="0.9">
            {/* Universal Safe Zone Bounding Box: X(50..950), Y(160..1480) */}
            <rect
              x="50"
              y="160"
              width="900"
              height="1320"
              fill="none"
              stroke="#38bdf8"
              strokeWidth="2.5"
              strokeDasharray="8 6"
              opacity="0.8"
            />

            {/* Top Danger Zone (0 - 160px) */}
            <rect x="0" y="0" width="1080" height="160" fill="url(#topExclusionGrad)" />
            <line
              x1="0"
              y1="160"
              x2="1080"
              y2="160"
              stroke="#ef4444"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <text
              x="540"
              y="145"
              textAnchor="middle"
              fill="#f87171"
              fontSize="20"
              fontWeight="600"
              letterSpacing="1.5"
              fontFamily="sans-serif"
            >
              TOP EXCLUSION · 160PX (HEADER & SEARCH)
            </text>

            {/* Bottom Danger Zone (1480 - 1920px) */}
            <rect x="0" y="1480" width="1080" height="440" fill="url(#bottomExclusionGrad)" />
            <line
              x1="0"
              y1="1480"
              x2="1080"
              y2="1480"
              stroke="#ef4444"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <text
              x="540"
              y="1510"
              textAnchor="middle"
              fill="#f87171"
              fontSize="20"
              fontWeight="600"
              letterSpacing="1.5"
              fontFamily="sans-serif"
            >
              BOTTOM EXCLUSION · 440PX (USERNAME & AUDIO)
            </text>

            {/* Right Danger Zone (950 - 1080px, Y: 600 - 1500) */}
            <rect x="950" y="600" width="130" height="900" fill="url(#rightExclusionGrad)" />
            <line
              x1="950"
              y1="600"
              x2="950"
              y2="1500"
              stroke="#ef4444"
              strokeWidth="2"
              strokeDasharray="6 4"
            />

            {/* Left Margin Guide (X = 50) */}
            <line
              x1="50"
              y1="160"
              x2="50"
              y2="1480"
              stroke="#38bdf8"
              strokeWidth="1.5"
              strokeDasharray="4 4"
              opacity="0.6"
            />

            {/* Safe Caption Baseline Guide: Y = 1380px */}
            <line
              x1="60"
              y1="1380"
              x2="940"
              y2="1380"
              stroke="#10b981"
              strokeWidth="2"
              strokeDasharray="6 4"
              opacity="0.85"
            />
            <text
              x="540"
              y="1368"
              textAnchor="middle"
              fill="#34d399"
              fontSize="18"
              fontWeight="600"
              letterSpacing="1"
              fontFamily="sans-serif"
            >
              SAFE CAPTION BASELINE (1380px)
            </text>
          </g>
        ) : null}

        {/* 2. Platform Wireframe Chrome Simulator Layer */}
        {showChrome && activePlatform === "tiktok" ? (
          <g data-testid="platform-chrome-tiktok" fill="#ffffff" opacity="0.85">
            {/* Top Navigation */}
            <g transform="translate(60, 80)">
              {/* LIVE icon */}
              <circle cx="20" cy="20" r="14" fill="none" stroke="#ffffff" strokeWidth="3" />
              <polygon points="17,14 26,20 17,26" fill="#ffffff" />
              <text x="44" y="26" fontSize="22" fontWeight="700">LIVE</text>
            </g>
            <g transform="translate(540, 100)" textAnchor="middle" fontFamily="sans-serif">
              <text x="-90" y="0" fontSize="26" fill="#ffffff" opacity="0.6" fontWeight="600">
                Following
              </text>
              <text x="90" y="0" fontSize="28" fill="#ffffff" fontWeight="700">
                For You
              </text>
              <line x1="45" y1="12" x2="135" y2="12" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
            </g>
            <g transform="translate(980, 85)">
              {/* Search Icon */}
              <circle cx="16" cy="16" r="12" fill="none" stroke="#ffffff" strokeWidth="3.5" />
              <line x1="25" y1="25" x2="35" y2="35" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" />
            </g>

            {/* Right Action Rail */}
            {/* Profile Avatar + Plus */}
            <g transform="translate(995, 760)">
              <circle cx="25" cy="25" r="32" fill="#262626" stroke="#ffffff" strokeWidth="2.5" />
              <circle cx="25" cy="20" r="12" fill="#ffffff" opacity="0.8" />
              <path d="M12 44 C12 34, 38 34, 38 44 Z" fill="#ffffff" opacity="0.8" />
              <circle cx="25" cy="56" r="11" fill="#ef4444" />
              <path d="M21 56 L29 56 M25 52 L25 60" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
            </g>

            {/* Like Heart */}
            <g transform="translate(995, 890)" textAnchor="middle">
              <path
                d="M25 35 C15 22, 6 12, 14 4 C21 -3, 25 3, 25 3 C25 3, 29 -3, 36 4 C44 12, 35 22, 25 35 Z"
                fill="#ffffff"
                transform="translate(0, 0) scale(1.1)"
              />
              <text x="27" y="65" fontSize="20" fontWeight="600">1.2M</text>
            </g>

            {/* Comment Bubble */}
            <g transform="translate(995, 1010)" textAnchor="middle">
              <path
                d="M10 10 A16 16 0 0 1 42 10 A16 16 0 0 1 42 32 A16 16 0 0 1 20 32 L10 40 L12 30 A16 16 0 0 1 10 10 Z"
                fill="#ffffff"
              />
              <circle cx="20" cy="21" r="2.5" fill="#18181b" />
              <circle cx="26" cy="21" r="2.5" fill="#18181b" />
              <circle cx="32" cy="21" r="2.5" fill="#18181b" />
              <text x="26" y="62" fontSize="20" fontWeight="600">38.4K</text>
            </g>

            {/* Bookmark Ribbon */}
            <g transform="translate(995, 1130)" textAnchor="middle">
              <path d="M12 8 L38 8 L38 42 L25 32 L12 42 Z" fill="#ffffff" />
              <text x="25" y="64" fontSize="20" fontWeight="600">89.1K</text>
            </g>

            {/* Share Arrow */}
            <g transform="translate(995, 1250)" textAnchor="middle">
              <path
                d="M24 8 L38 20 L24 32 L24 24 C14 24, 10 28, 6 36 C8 24, 14 16, 24 16 Z"
                fill="#ffffff"
              />
              <text x="24" y="62" fontSize="20" fontWeight="600">12.5K</text>
            </g>

            {/* Vinyl Record Music Disc */}
            <g transform="translate(995, 1370)">
              <circle cx="26" cy="26" r="26" fill="#18181b" stroke="#ffffff" strokeWidth="2.5" />
              <circle cx="26" cy="26" r="16" fill="#27272a" />
              <circle cx="26" cy="26" r="7" fill="#ef4444" />
              <circle cx="26" cy="26" r="2" fill="#ffffff" />
            </g>

            {/* Bottom Left Creator Metadata */}
            <g transform="translate(60, 1530)" fontFamily="sans-serif">
              <text x="0" y="24" fontSize="28" fontWeight="700">@aksharo.official</text>
              <text x="0" y="64" fontSize="22" fontWeight="400" fill="#f4f4f5">
                Social safe-zone engine keeps your captions clear! ✨
              </text>
              <g transform="translate(0, 85)">
                <path d="M6 16 A4 4 0 1 1 2 12 L10 12 L10 2 A4 4 0 0 1 18 2 L18 14 A4 4 0 1 1 14 10 L14 6" fill="#ffffff" transform="scale(0.9)" />
                <text x="32" y="16" fontSize="20" fill="#e4e4e7">Original Sound - Aksharo AI</text>
              </g>
            </g>

            {/* Bottom Navigation Bar */}
            <g transform="translate(0, 1820)" stroke="#ffffff" strokeWidth="2.5" fill="none">
              <line x1="0" y1="0" x2="1080" y2="0" stroke="#ffffff" strokeWidth="0.5" opacity="0.3" />
              {/* Home */}
              <path d="M100 45 L118 28 L136 45 L136 65 L100 65 Z" fill="#ffffff" />
              {/* Friends */}
              <circle cx="320" cy="40" r="10" />
              <path d="M305 65 C305 52, 335 52, 335 65" />
              {/* Plus Button */}
              <g transform="translate(515, 26)" stroke="none">
                <rect x="0" y="0" width="50" height="38" rx="10" fill="#ffffff" />
                <path d="M25 10 L25 28 M16 19 L34 19" stroke="#18181b" strokeWidth="3.5" strokeLinecap="round" />
              </g>
              {/* Inbox */}
              <rect x="740" y="32" width="36" height="28" rx="6" />
              <path d="M740 44 L758 54 L776 44" />
              {/* Profile */}
              <circle cx="960" cy="40" r="10" />
              <path d="M945 65 C945 52, 975 52, 975 65" />
            </g>
          </g>
        ) : null}

        {/* 3. Instagram Reels Chrome Wireframe */}
        {showChrome && activePlatform === "reels" ? (
          <g data-testid="platform-chrome-reels" fill="#ffffff" opacity="0.85">
            {/* Top Bar */}
            <g transform="translate(60, 95)" fontFamily="sans-serif">
              <text x="0" y="0" fontSize="34" fontWeight="800" letterSpacing="-0.5">Reels</text>
            </g>
            <g transform="translate(980, 75)">
              <rect x="0" y="6" width="36" height="26" rx="6" fill="none" stroke="#ffffff" strokeWidth="3" />
              <polygon points="12,14 12,24 24,19" fill="#ffffff" />
            </g>

            {/* Right Action Rail */}
            <g transform="translate(995, 960)" textAnchor="middle">
              {/* Heart */}
              <path d="M25 35 C15 22, 6 12, 14 4 C21 -3, 25 3, 25 3 C25 3, 29 -3, 36 4 C44 12, 35 22, 25 35 Z" fill="#ffffff" />
              <text x="25" y="60" fontSize="20" fontWeight="600">84.2K</text>
            </g>
            <g transform="translate(995, 1080)" textAnchor="middle">
              {/* Comment */}
              <circle cx="25" cy="20" r="18" fill="none" stroke="#ffffff" strokeWidth="3.5" />
              <path d="M12 30 L8 40 L18 36" fill="#ffffff" stroke="#ffffff" strokeWidth="2" />
              <text x="25" y="62" fontSize="20" fontWeight="600">1,940</text>
            </g>
            <g transform="translate(995, 1200)" textAnchor="middle">
              {/* Send / Paper airplane */}
              <path d="M8 8 L40 22 L8 36 L14 22 Z" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinejoin="round" />
              <text x="24" y="62" fontSize="20" fontWeight="600">22.8K</text>
            </g>
            <g transform="translate(995, 1320)">
              {/* Three dots */}
              <circle cx="24" cy="12" r="3.5" fill="#ffffff" />
              <circle cx="24" cy="24" r="3.5" fill="#ffffff" />
              <circle cx="24" cy="36" r="3.5" fill="#ffffff" />
            </g>
            <g transform="translate(995, 1420)">
              {/* Audio Box */}
              <rect x="6" y="6" width="36" height="36" rx="8" fill="#27272a" stroke="#ffffff" strokeWidth="2.5" />
              <circle cx="24" cy="24" r="6" fill="#ffffff" />
            </g>

            {/* Bottom Left Profile + Follow */}
            <g transform="translate(60, 1560)" fontFamily="sans-serif">
              <circle cx="24" cy="24" r="24" fill="#3f3f46" stroke="#ffffff" strokeWidth="2" />
              <text x="64" y="32" fontSize="26" fontWeight="700">crestmond</text>
              <rect x="220" y="8" width="90" height="34" rx="8" fill="none" stroke="#ffffff" strokeWidth="2" />
              <text x="265" y="32" textAnchor="middle" fontSize="18" fontWeight="600">Follow</text>
              <text x="0" y="85" fontSize="22" fontWeight="400" fill="#f4f4f5">
                Always clear captions powered by Aksharo Safe-Zone #reels
              </text>
            </g>
          </g>
        ) : null}

        {/* 4. YouTube Shorts Chrome Wireframe */}
        {showChrome && activePlatform === "shorts" ? (
          <g data-testid="platform-chrome-shorts" fill="#ffffff" opacity="0.85">
            {/* Top Bar */}
            <g transform="translate(920, 80)">
              <circle cx="16" cy="16" r="11" fill="none" stroke="#ffffff" strokeWidth="3" />
              <line x1="24" y1="24" x2="34" y2="34" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
            </g>
            <g transform="translate(995, 80)">
              <circle cx="20" cy="10" r="3.5" fill="#ffffff" />
              <circle cx="20" cy="22" r="3.5" fill="#ffffff" />
              <circle cx="20" cy="34" r="3.5" fill="#ffffff" />
            </g>

            {/* Right Action Rail */}
            <g transform="translate(995, 960)" textAnchor="middle">
              {/* Thumbs Up */}
              <path d="M12 18 L12 36 L18 36 L18 18 Z M20 18 L26 6 C28 4, 34 8, 32 14 L30 18 L42 18 C44 18, 46 20, 46 22 L40 36 C39 38, 37 39, 35 39 L20 39 Z" fill="#ffffff" />
              <text x="26" y="60" fontSize="20" fontWeight="600">142K</text>
            </g>
            <g transform="translate(995, 1080)" textAnchor="middle">
              {/* Thumbs Down */}
              <path d="M12 21 L12 3 L18 3 L18 21 Z M20 21 L26 33 C28 35, 34 31, 32 25 L30 21 L42 21 C44 21, 46 19, 46 17 L40 3 C39 1, 37 0, 35 0 L20 0 Z" fill="#ffffff" />
              <text x="26" y="60" fontSize="20" fontWeight="600">Dislike</text>
            </g>
            <g transform="translate(995, 1200)" textAnchor="middle">
              {/* Comments */}
              <path d="M10 10 A16 16 0 0 1 42 10 A16 16 0 0 1 42 32 A16 16 0 0 1 20 32 L10 40 L12 30 A16 16 0 0 1 10 10 Z" fill="#ffffff" />
              <text x="26" y="62" fontSize="20" fontWeight="600">4,120</text>
            </g>
            <g transform="translate(995, 1320)" textAnchor="middle">
              {/* Share */}
              <path d="M24 8 L38 20 L24 32 L24 24 C14 24, 10 28, 6 36 C8 24, 14 16, 24 16 Z" fill="#ffffff" />
              <text x="24" y="62" fontSize="20" fontWeight="600">Share</text>
            </g>
            <g transform="translate(995, 1440)" textAnchor="middle">
              {/* Remix */}
              <rect x="8" y="8" width="32" height="32" rx="8" fill="none" stroke="#ffffff" strokeWidth="3" />
              <path d="M16 24 L24 16 L32 24" fill="none" stroke="#ffffff" strokeWidth="3" />
              <text x="24" y="62" fontSize="20" fontWeight="600">Remix</text>
            </g>

            {/* Bottom Left Channel */}
            <g transform="translate(60, 1620)" fontFamily="sans-serif">
              <circle cx="24" cy="24" r="24" fill="#dc2626" />
              <text x="64" y="32" fontSize="24" fontWeight="700">@AksharoShorts</text>
              <rect x="270" y="8" width="120" height="36" rx="18" fill="#dc2626" />
              <text x="330" y="32" textAnchor="middle" fontSize="18" fontWeight="700">Subscribe</text>
              <text x="0" y="85" fontSize="22" fontWeight="500">
                100% safe bounds compliance on YouTube Shorts #shorts
              </text>
            </g>
          </g>
        ) : null}
      </svg>

      {/* 5. Magnetic Safe-Zone Snap Feedback Banner */}
      {snapTooltip !== undefined ? (
        <div
          className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/50 bg-amber-500/95 px-4 py-1.5 text-xs font-semibold text-neutral-950 shadow-xl backdrop-blur-md transition-all animate-in fade-in zoom-in-95 duration-150"
          data-testid="safe-zone-snap-tooltip"
        >
          <svg className="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3" />
            <path d="M4 3h4" />
            <path d="M16 3h4" />
          </svg>
          <span>{snapTooltip}</span>
        </div>
      ) : null}
    </div>
  );
}
