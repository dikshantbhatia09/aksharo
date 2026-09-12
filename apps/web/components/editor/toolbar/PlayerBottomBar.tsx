"use client";

/**
 * The strip directly under the video preview (design/08 §4): play/pause,
 * mute, an `HH:MM:SS / HH:MM:SS` counter and fullscreen. Export stays where
 * it already lives (the editor's own utility header) rather than being
 * duplicated here — this bar only adds the playback controls that header
 * never had.
 */
import { Maximize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

function formatClock(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export interface PlayerBottomBarProps {
  readonly playing: boolean;
  readonly onTogglePlay: () => void;
  readonly muted: boolean;
  readonly onMutedChange: (muted: boolean) => void;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly onSeek?: (ms: number) => void;
  /** The element to fullscreen — the stage box, not just the `<video>`, so the caption overlay stays visible. */
  readonly fullscreenTarget: React.RefObject<HTMLElement | null>;
  readonly className?: string;
}

export function PlayerBottomBar({
  playing,
  onTogglePlay,
  muted,
  onMutedChange,
  positionMs,
  durationMs,
  onSeek,
  fullscreenTarget,
  className,
}: PlayerBottomBarProps): React.JSX.Element {
  const [fullscreen, setFullscreen] = React.useState(false);

  React.useEffect(() => {
    function onChange(): void {
      setFullscreen(document.fullscreenElement === fullscreenTarget.current);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [fullscreenTarget]);

  function toggleFullscreen(): void {
    const target = fullscreenTarget.current;
    if (target === null) return;
    if (document.fullscreenElement === target) {
      void document.exitFullscreen();
    } else {
      void target.requestFullscreen();
    }
  }

  return (
    <div
      className={cn("editor-player-bottom flex w-full shrink-0 flex-col justify-center", className)}
      data-testid="player-bottom-bar"
    >
      <input
        type="range"
        min={0}
        max={Math.max(1, durationMs)}
        step={1}
        value={Math.min(positionMs, durationMs)}
        onChange={(event) => onSeek?.(Number(event.target.value))}
        aria-label="Playback position"
        className="editor-player-scrubber panel-range"
      />
      <div className="editor-player-controls flex w-full items-center">
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          data-testid="player-play-pause"
          onClick={onTogglePlay}
          className="text-fg-1 hover:bg-bg-2 hover:text-fg-0 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-[160ms]"
        >
          {playing ? (
            <Pause className="size-4 fill-current" aria-hidden="true" />
          ) : (
            <Play className="size-4 fill-current" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
          data-testid="player-mute-toggle"
          onClick={() => {
            onMutedChange(!muted);
          }}
          className="text-fg-2 hover:bg-bg-2 hover:text-fg-0 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-[160ms]"
        >
          {muted ? (
            <VolumeX className="size-4" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4" aria-hidden="true" />
          )}
        </button>

        <span
          className="text-fg-1 font-mono text-xs tabular-nums"
          data-testid="player-time-counter"
        >
          {formatClock(positionMs)} <span className="text-fg-disabled">/</span>{" "}
          <span className="text-editor-muted">{formatClock(durationMs)}</span>
        </span>

        <button
          type="button"
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          data-testid="player-fullscreen-toggle"
          onClick={toggleFullscreen}
          className="text-fg-2 hover:bg-bg-2 hover:text-fg-0 ml-auto flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-[160ms]"
        >
          <Maximize className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
