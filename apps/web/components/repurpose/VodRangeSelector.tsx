"use client";

import * as React from "react";
import { cn } from "@montaj/ui";
import type {
  ChatDensityBucket,
  ChatPeakHighlight,
  VodProbeResponse,
} from "@montaj/repurpose-contracts";
import { formatClock } from "@/components/repurpose/moment-time";
import { Flame, Play, Radio, Sparkles, Zap } from "lucide-react";

export interface VodRangeSelectorProps {
  readonly probe?: VodProbeResponse | null;
  readonly isLoading?: boolean;
  readonly error?: string | null;
  readonly onSelectStartAt?: (startSec: number) => void;
  readonly onSelectRange?: (range: { startSec: number; endSec: number }) => void;
  readonly className?: string;
}

export function VodRangeSelector({
  probe,
  isLoading = false,
  error = null,
  onSelectStartAt,
  onSelectRange,
  className,
}: VodRangeSelectorProps) {
  const [selectedRange, setSelectedRange] = React.useState<{
    startSec: number;
    endSec: number;
  } | null>(null);

  const [activePeakIndex, setActivePeakIndex] = React.useState<number | null>(null);

  // When a probe arrives, default selected range to top peak or first 30 mins
  React.useEffect(() => {
    if (probe && probe.peaks.length > 0) {
      const topPeak = probe.peaks[0]!;
      setSelectedRange({ startSec: topPeak.startSec, endSec: topPeak.endSec });
      setActivePeakIndex(0);
    } else if (probe && probe.durationSec > 0) {
      const endSec = Math.min(probe.durationSec, 3600);
      setSelectedRange({ startSec: 0, endSec });
    }
  }, [probe]);

  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "rounded-lg border border-border/70 bg-sunken/40 p-3.5 space-y-3 animate-pulse",
          className,
        )}
        data-testid="vod-range-selector-skeleton"
      >
        <div className="flex gap-3 items-center">
          <div className="w-28 sm:w-36 aspect-video bg-border/40 rounded flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-border/40 rounded w-3/4" />
            <div className="h-3 bg-border/30 rounded w-1/3" />
          </div>
        </div>
        <div className="h-16 bg-border/20 rounded w-full" />
        <p className="text-[11px] text-fg-3 flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-accent animate-ping" />
          Mining VOD chat replay and viral hype density spikes...
        </p>
      </div>
    );
  }

  if (error && !probe) {
    return null;
  }

  if (!probe) {
    return null;
  }

  const {
    platform,
    title,
    channelName,
    durationSec,
    thumbnailUrl,
    isLive,
    chatVelocity,
    peaks,
  } = probe;

  const durationFormatted = formatClock(durationSec * 1000);
  const maxMps = Math.max(...chatVelocity.map((b) => b.mps), 1);

  const handleSelectPeak = (peak: ChatPeakHighlight, index: number) => {
    setSelectedRange({ startSec: peak.startSec, endSec: peak.endSec });
    setActivePeakIndex(index);
    if (onSelectStartAt) {
      onSelectStartAt(peak.startSec);
    }
    if (onSelectRange) {
      onSelectRange({ startSec: peak.startSec, endSec: peak.endSec });
    }
  };

  const handleAutoSelectTop3 = () => {
    if (peaks.length === 0) return;
    const topPeaks = peaks.slice(0, 3);
    const minStart = Math.min(...topPeaks.map((p) => p.startSec));
    const maxEnd = Math.max(...topPeaks.map((p) => p.endSec));
    setSelectedRange({ startSec: minStart, endSec: maxEnd });
    setActivePeakIndex(0);
    if (onSelectStartAt) {
      onSelectStartAt(minStart);
    }
    if (onSelectRange) {
      onSelectRange({ startSec: minStart, endSec: maxEnd });
    }
  };

  const handleRangeChange = (startSec: number, endSec: number) => {
    const validStart = Math.max(0, Math.min(startSec, durationSec));
    const validEnd = Math.max(validStart, Math.min(endSec, durationSec));
    setSelectedRange({ startSec: validStart, endSec: validEnd });
    setActivePeakIndex(null);
    if (onSelectStartAt) {
      onSelectStartAt(validStart);
    }
    if (onSelectRange) {
      onSelectRange({ startSec: validStart, endSec: validEnd });
    }
  };

  const platformBadgeColor =
    platform === "TWITCH"
      ? "bg-purple-600/20 text-purple-400 border-purple-500/40"
      : platform === "KICK"
        ? "bg-emerald-600/20 text-emerald-400 border-emerald-500/40"
        : "bg-red-600/20 text-red-400 border-red-500/40";

  return (
    <section
      aria-label="Livestream & VOD Range Selector"
      className={cn(
        "rounded-lg border border-border/80 bg-sunken/60 p-4 space-y-3.5 transition-all",
        className,
      )}
      data-testid="vod-range-selector"
    >
      {/* VOD Header Details */}
      <div className="flex flex-col sm:flex-row gap-3.5 items-start">
        <div className="relative w-full sm:w-36 aspect-video rounded overflow-hidden bg-black/30 flex-shrink-0 border border-border/40">
          {thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailUrl}
              alt={title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-sunken text-fg-3">
              <Play className="w-6 h-6 opacity-40" />
            </div>
          )}
          <span
            className={cn(
              "absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium tracking-tight bg-black/80 text-white",
              isLive && "bg-red-600 text-white animate-pulse",
            )}
          >
            {isLive ? "LIVE" : durationFormatted}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className={cn(
                "px-2 py-0.5 rounded text-[10px] font-semibold tracking-wider uppercase border",
                platformBadgeColor,
              )}
            >
              {platform.replace("_", " ")}
            </span>
            {isLive ? (
              <span className="flex items-center gap-1 text-[11px] text-red-400 font-medium">
                <Radio className="w-3 h-3 animate-pulse" />
                Live Broadcast
              </span>
            ) : null}
          </div>
          <h4 className="text-sm font-medium text-fg truncate" title={title}>
            {title}
          </h4>
          <p className="text-xs text-fg-2 truncate">{channelName}</p>
          <p className="text-[11px] text-fg-3 mt-1">
            Total Duration: {durationFormatted} • {peaks.length} chat velocity peaks detected
          </p>
        </div>
      </div>

      {/* Chat Density Waveform & Timeline Heatmap */}
      <div className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-fg flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-amber-500" />
            Chat Replay Sentiment & Velocity Heatmap
          </span>
          {peaks.length > 0 ? (
            <button
              type="button"
              onClick={handleAutoSelectTop3}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline cursor-pointer"
              data-testid="auto-select-top-3-btn"
            >
              <Sparkles className="w-3 h-3" />
              Auto-Select Top 3 Peaks
            </button>
          ) : null}
        </div>

        {/* Heatmap visualization bar */}
        <div
          className="relative h-14 w-full bg-sunken rounded border border-border/50 overflow-hidden flex items-end p-0.5"
          data-testid="chat-velocity-graph"
        >
          {chatVelocity.length > 0 ? (
            <svg
              className="w-full h-full"
              viewBox={`0 0 ${chatVelocity.length} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="velocityGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.8" />
                  <stop offset="50%" stopColor="#ef4444" stopOpacity="0.5" />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.1" />
                </linearGradient>
              </defs>
              {chatVelocity.map((bucket, i) => {
                const heightPct = Math.min(100, (bucket.mps / maxMps) * 95);
                return (
                  <rect
                    key={bucket.timestampSec}
                    x={i}
                    y={100 - heightPct}
                    width={1}
                    height={heightPct}
                    fill="url(#velocityGrad)"
                  />
                );
              })}
            </svg>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[11px] text-fg-3">
              Standard stream density
            </div>
          )}

          {/* Peak Highlight Indicators */}
          {durationSec > 0 &&
            peaks.map((peak, idx) => {
              const leftPct = (peak.startSec / durationSec) * 100;
              const widthPct = Math.max(
                1.5,
                ((peak.endSec - peak.startSec) / durationSec) * 100,
              );
              const isActive = activePeakIndex === idx;

              return (
                <button
                  key={`${peak.startSec}-${idx}`}
                  type="button"
                  title={`${peak.reason || "Spike"} (Score: ${peak.score})`}
                  onClick={() => handleSelectPeak(peak, idx)}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  className={cn(
                    "absolute top-0 bottom-0 bg-amber-500/30 hover:bg-amber-400/50 border-x border-amber-400/80 transition-colors cursor-pointer group flex items-start justify-center",
                    isActive && "bg-amber-400/60 ring-2 ring-amber-400",
                  )}
                  data-testid={`peak-marker-${idx}`}
                >
                  <span className="inline-block mt-0.5 p-0.5 bg-amber-500 text-black rounded-full shadow-sm text-[9px] group-hover:scale-110">
                    <Zap className="w-2.5 h-2.5 fill-current" />
                  </span>
                </button>
              );
            })}
        </div>
      </div>

      {/* Highlight Peak Badges & Emotes */}
      {peaks.length > 0 ? (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-fg-2">
            Spike Highlight Candidates:
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="peak-badges-list">
            {peaks.slice(0, 5).map((peak, idx) => {
              const isActive = activePeakIndex === idx;
              const peakTime = `${formatClock(peak.startSec * 1000)} - ${formatClock(peak.endSec * 1000)}`;

              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSelectPeak(peak, idx)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-md border flex items-center gap-1.5 transition-colors cursor-pointer text-left",
                    isActive
                      ? "bg-accent/15 border-accent text-accent font-medium shadow-sm"
                      : "bg-surface/50 border-border/70 text-fg-2 hover:bg-surface hover:text-fg",
                  )}
                  data-testid={`peak-badge-${idx}`}
                >
                  <Flame className="w-3 h-3 text-amber-500 flex-shrink-0" />
                  <span className="font-mono text-[11px]">{peakTime}</span>
                  <span className="text-[10px] px-1 py-0.2 rounded bg-sunken text-fg-3 border border-border/40">
                    {peak.score} pts
                  </span>
                  {peak.topEmotes.length > 0 ? (
                    <span className="text-[10px] text-amber-400 font-semibold">
                      [{peak.topEmotes.slice(0, 2).join(" ")}]
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Selected Time-Range Summary & Quick Inputs */}
      {selectedRange ? (
        <div className="pt-1 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-fg-3">Selective Ingestion Window:</span>
            <span className="font-mono font-medium text-fg">
              {formatClock(selectedRange.startSec * 1000)} →{" "}
              {formatClock(selectedRange.endSec * 1000)}
            </span>
            <span className="text-[11px] text-fg-3">
              ({formatClock((selectedRange.endSec - selectedRange.startSec) * 1000)} total)
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleRangeChange(0, Math.min(durationSec, 3600))}
              className="px-2 py-0.5 rounded text-[11px] border border-border/60 bg-surface/40 hover:bg-surface text-fg-2"
            >
              First 1h
            </button>
            <button
              type="button"
              onClick={() =>
                handleRangeChange(
                  Math.max(0, durationSec - 3600),
                  durationSec,
                )
              }
              className="px-2 py-0.5 rounded text-[11px] border border-border/60 bg-surface/40 hover:bg-surface text-fg-2"
            >
              Last 1h
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
