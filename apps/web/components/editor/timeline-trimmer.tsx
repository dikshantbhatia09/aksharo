"use client";

import {
  DEFAULT_FRAME_RATE,
  DEFAULT_SNAP_TOLERANCE_SEC,
  formatSecToTimecode,
  parseTimecodeToSec,
  sliceTranscriptLines,
  sliceTranscriptWords,
  snapToWordBoundary,
  type SlicedCaptionLine,
  type TimedWord,
} from "@montaj/repurpose-contracts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TimelineTrimmerProps {
  /** Current clip start timestamp in seconds. */
  readonly startSec: number;
  /** Current clip end timestamp in seconds. */
  readonly endSec: number;
  /** Original AI-selected start timestamp in seconds (for Reset to AI). */
  readonly aiStartSec?: number;
  /** Original AI-selected end timestamp in seconds (for Reset to AI). */
  readonly aiEndSec?: number;
  /** Total source video duration in seconds. */
  readonly videoDurationSec: number;
  /** Minimum allowed clip duration in seconds (default 3s). */
  readonly minDurationSec?: number;
  /** Maximum allowed clip duration in seconds (default 180s). */
  readonly maxDurationSec?: number;
  /** Full or window-scoped word-level transcript with start/end in seconds. */
  readonly words?: readonly TimedWord[];
  /** Optional normalized audio waveform peaks (0..1). */
  readonly waveformPeaks?: readonly number[];
  /** Optional filmstrip thumbnail URLs across the timeline window. */
  readonly filmstripThumbnails?: readonly string[];
  /** Optional ref to a HTMLVideoElement for < 16ms direct frame seek during drag. */
  readonly videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** Callback fired on < 16ms frame seek while scrubbing/dragging a handle. */
  readonly onSeek?: (timeSec: number) => void;
  /** Callback fired continuously as boundaries change in real time. */
  readonly onChange?: (bounds: {
    readonly startSec: number;
    readonly endSec: number;
    readonly bypassSnap: boolean;
    readonly snapped: boolean;
    readonly words: TimedWord[];
    readonly lines: SlicedCaptionLine[];
  }) => void;
  /** Callback fired when the user commits the trim (drag end, nudge, or Apply button). */
  readonly onCommit?: (bounds: {
    readonly startSec: number;
    readonly endSec: number;
    readonly bypassSnap: boolean;
    readonly isManualOverride: boolean;
  }) => void | Promise<void>;
  /** Whether a trim commit request is currently saving. */
  readonly busy?: boolean;
  /** Optional error message from the parent or server. */
  readonly errorMessage?: string | null;
}

const DEFAULT_MIN_DURATION_SEC = 3;
const DEFAULT_MAX_DURATION_SEC = 180;
const DEFAULT_PEAK_COUNT = 64;

/**
 * Generates deterministic, realistic-looking waveform amplitude bars when raw
 * audio peaks have not yet been loaded by the browser, ensuring the waveform
 * trimmer is always visually responsive.
 */
function buildFallbackPeaks(
  count: number,
  windowStartSec: number,
  windowEndSec: number,
  words: readonly TimedWord[],
): number[] {
  const span = Math.max(1, windowEndSec - windowStartSec);
  const peaks: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = windowStartSec + ((i + 0.5) / count) * span;
    const speaking = words.some((w) => t >= w.start - 0.05 && t <= w.end + 0.05);
    const wave =
      Math.abs(Math.sin(t * 3.7 + i * 0.45)) * 0.55 +
      Math.abs(Math.cos(t * 7.3 - i * 0.2)) * 0.35;
    const amplitude = speaking ? Math.min(1, 0.28 + wave * 0.72) : Math.max(0.08, wave * 0.22);
    peaks.push(Number(amplitude.toFixed(3)));
  }
  return peaks;
}

export function TimelineTrimmer({
  startSec,
  endSec,
  aiStartSec,
  aiEndSec,
  videoDurationSec,
  minDurationSec = DEFAULT_MIN_DURATION_SEC,
  maxDurationSec = DEFAULT_MAX_DURATION_SEC,
  words = [],
  waveformPeaks,
  filmstripThumbnails,
  videoRef,
  onSeek,
  onChange,
  onCommit,
  busy = false,
  errorMessage = null,
}: TimelineTrimmerProps): React.ReactElement {
  const [draftStartSec, setDraftStartSec] = useState<number>(startSec);
  const [draftEndSec, setDraftEndSec] = useState<number>(endSec);
  const [startInput, setStartInput] = useState<string>(() => formatSecToTimecode(startSec));
  const [endInput, setEndInput] = useState<string>(() => formatSecToTimecode(endSec));
  const [magneticSnap, setMagneticSnap] = useState<boolean>(true);
  const [shiftHeld, setShiftHeld] = useState<boolean>(false);
  const [lastSnappedHandle, setLastSnappedHandle] = useState<"start" | "end" | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);
  const [wordClickTarget, setWordClickTarget] = useState<"auto" | "start" | "end">("auto");
  const [localError, setLocalError] = useState<string | null>(null);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const lastSeekFrameRef = useRef<number>(0);

  // Sync props when clip bounds are updated externally.
  useEffect(() => {
    setDraftStartSec(startSec);
    setDraftEndSec(endSec);
    setStartInput(formatSecToTimecode(startSec));
    setEndInput(formatSecToTimecode(endSec));
    setLocalError(null);
  }, [startSec, endSec]);

  // Compute visible timeline window around the current clip so handles have
  // breathing room to expand or contract.
  const { windowStartSec, windowEndSec } = useMemo(() => {
    const clipLen = Math.max(minDurationSec, endSec - startSec);
    const pad = Math.max(10, Math.min(30, clipLen * 0.45));
    const wStart = Math.max(0, Math.min(startSec, draftStartSec) - pad);
    const maxEnd = videoDurationSec > 0 ? videoDurationSec : Math.max(endSec, draftEndSec) + pad;
    const wEnd = Math.min(maxEnd, Math.max(endSec, draftEndSec) + pad);
    return {
      windowStartSec: wStart,
      windowEndSec: Math.max(wStart + minDurationSec + 1, wEnd),
    };
  }, [startSec, endSec, draftStartSec, draftEndSec, minDurationSec, videoDurationSec]);

  const windowDurationSec = Math.max(1, windowEndSec - windowStartSec);

  // Instant < 16ms video frame seek helper.
  const seekVideoInstant = useCallback(
    (targetSec: number) => {
      const clamped = Math.max(
        0,
        videoDurationSec > 0 ? Math.min(videoDurationSec, targetSec) : targetSec,
      );
      if (videoRef?.current) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          // Ignore DOM media errors on unmounted/mocked video elements
        }
      }
      onSeek?.(clamped);
      lastSeekFrameRef.current = clamped;
    },
    [onSeek, videoDurationSec, videoRef],
  );

  // Real-time sliced transcript words & subtitle lines for current draft bounds.
  const slicedWords = useMemo(
    () => sliceTranscriptWords(words, draftStartSec, draftEndSec),
    [words, draftStartSec, draftEndSec],
  );

  const slicedLines = useMemo(
    () => sliceTranscriptLines(words, draftStartSec, draftEndSec),
    [words, draftStartSec, draftEndSec],
  );

  // Words inside the visible timeline window for text-linked trimming.
  const windowWords = useMemo(
    () =>
      words.filter(
        (w) =>
          Number.isFinite(w.start) &&
          Number.isFinite(w.end) &&
          w.end > windowStartSec &&
          w.start < windowEndSec,
      ),
    [words, windowStartSec, windowEndSec],
  );

  const peaks = useMemo(() => {
    if (waveformPeaks && waveformPeaks.length > 0) {
      return waveformPeaks;
    }
    return buildFallbackPeaks(DEFAULT_PEAK_COUNT, windowStartSec, windowEndSec, windowWords);
  }, [waveformPeaks, windowStartSec, windowEndSec, windowWords]);

  const applyBounds = useCallback(
    (
      nextStartRaw: number,
      nextEndRaw: number,
      activeHandle: "start" | "end" | "both",
      bypassSnapOverride?: boolean,
    ): { startSec: number; endSec: number; bypassSnap: boolean; snapped: boolean } => {
      const maxVideo = videoDurationSec > 0 ? videoDurationSec : Number.POSITIVE_INFINITY;
      const effectiveBypass = bypassSnapOverride ?? (!magneticSnap || shiftHeld);

      let resolvedStart = Math.max(0, Math.min(nextStartRaw, maxVideo));
      let resolvedEnd = Math.max(0, Math.min(nextEndRaw, maxVideo));
      let snapped = false;

      if (activeHandle === "start" || activeHandle === "both") {
        const snapRes = snapToWordBoundary(resolvedStart, words, "start", {
          snapToleranceSec: DEFAULT_SNAP_TOLERANCE_SEC,
          bypassSnap: effectiveBypass,
          fps: DEFAULT_FRAME_RATE,
        });
        resolvedStart = snapRes.timeSec;
        if (snapRes.snapped) snapped = true;
      }

      if (activeHandle === "end" || activeHandle === "both") {
        const snapRes = snapToWordBoundary(resolvedEnd, words, "end", {
          snapToleranceSec: DEFAULT_SNAP_TOLERANCE_SEC,
          bypassSnap: effectiveBypass,
          fps: DEFAULT_FRAME_RATE,
        });
        resolvedEnd = snapRes.timeSec;
        if (snapRes.snapped) snapped = true;
      }

      // Enforce min/max duration constraints.
      if (resolvedEnd - resolvedStart < minDurationSec) {
        if (activeHandle === "start") {
          resolvedStart = Math.max(0, resolvedEnd - minDurationSec);
        } else {
          resolvedEnd = Math.min(maxVideo, resolvedStart + minDurationSec);
        }
      } else if (resolvedEnd - resolvedStart > maxDurationSec) {
        if (activeHandle === "start") {
          resolvedStart = resolvedEnd - maxDurationSec;
        } else {
          resolvedEnd = resolvedStart + maxDurationSec;
        }
      }

      resolvedStart = Number(resolvedStart.toFixed(3));
      resolvedEnd = Number(resolvedEnd.toFixed(3));

      setDraftStartSec(resolvedStart);
      setDraftEndSec(resolvedEnd);
      setStartInput(formatSecToTimecode(resolvedStart));
      setEndInput(formatSecToTimecode(resolvedEnd));
      setLastSnappedHandle(snapped && activeHandle !== "both" ? activeHandle : null);
      setLocalError(null);

      const nextWords = sliceTranscriptWords(words, resolvedStart, resolvedEnd);
      const nextLines = sliceTranscriptLines(words, resolvedStart, resolvedEnd);

      onChange?.({
        startSec: resolvedStart,
        endSec: resolvedEnd,
        bypassSnap: effectiveBypass,
        snapped,
        words: nextWords,
        lines: nextLines,
      });

      if (activeHandle === "start") {
        seekVideoInstant(resolvedStart);
      } else if (activeHandle === "end") {
        seekVideoInstant(resolvedEnd);
      }

      return {
        startSec: resolvedStart,
        endSec: resolvedEnd,
        bypassSnap: effectiveBypass,
        snapped,
      };
    },
    [
      videoDurationSec,
      magneticSnap,
      shiftHeld,
      words,
      minDurationSec,
      maxDurationSec,
      onChange,
      seekVideoInstant,
    ],
  );

  // Convert clientX pointer position into a timeline timestamp in seconds.
  const clientXToTimeSec = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return draftStartSec;
      const rect = el.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : 600;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / width));
      return windowStartSec + ratio * windowDurationSec;
    },
    [draftStartSec, windowStartSec, windowDurationSec],
  );

  // Handle pointer dragging for start/end handles.
  useEffect(() => {
    if (draggingHandle === null) return;

    const onPointerMove = (event: PointerEvent | MouseEvent) => {
      const isShift = Boolean(event.shiftKey || event.altKey);
      setShiftHeld(isShift);
      const targetTimeSec = clientXToTimeSec(event.clientX);
      const bypass = !magneticSnap || isShift;
      if (draggingHandle === "start") {
        applyBounds(targetTimeSec, draftEndSec, "start", bypass);
      } else {
        applyBounds(draftStartSec, targetTimeSec, "end", bypass);
      }
    };

    const onPointerUp = (event: PointerEvent | MouseEvent) => {
      const isShift = Boolean(event.shiftKey || event.altKey);
      setShiftHeld(false);
      setDraggingHandle(null);
      const bypass = !magneticSnap || isShift;
      void onCommit?.({
        startSec: draftStartSec,
        endSec: draftEndSec,
        bypassSnap: bypass,
        isManualOverride: true,
      });
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [
    draggingHandle,
    clientXToTimeSec,
    magneticSnap,
    applyBounds,
    draftStartSec,
    draftEndSec,
    onCommit,
  ]);

  const handleKeyDown = useCallback(
    (handle: "start" | "end", event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const isFineFrameStep = event.shiftKey || event.altKey || !magneticSnap;
      const stepSec = isFineFrameStep ? 1 / DEFAULT_FRAME_RATE : 0.25;
      if (handle === "start") {
        const next = applyBounds(
          draftStartSec + direction * stepSec,
          draftEndSec,
          "start",
          isFineFrameStep,
        );
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: next.bypassSnap,
          isManualOverride: true,
        });
      } else {
        const next = applyBounds(
          draftStartSec,
          draftEndSec + direction * stepSec,
          "end",
          isFineFrameStep,
        );
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: next.bypassSnap,
          isManualOverride: true,
        });
      }
    },
    [magneticSnap, applyBounds, draftStartSec, draftEndSec, onCommit],
  );

  const handleNudge = useCallback(
    (handle: "start" | "end", deltaSec: number) => {
      if (handle === "start") {
        const next = applyBounds(draftStartSec + deltaSec, draftEndSec, "start");
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: next.bypassSnap,
          isManualOverride: true,
        });
      } else {
        const next = applyBounds(draftStartSec, draftEndSec + deltaSec, "end");
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: next.bypassSnap,
          isManualOverride: true,
        });
      }
    },
    [applyBounds, draftStartSec, draftEndSec, onCommit],
  );

  const handleWordClick = useCallback(
    (word: TimedWord) => {
      let targetHandle: "start" | "end";
      if (wordClickTarget === "start" || wordClickTarget === "end") {
        targetHandle = wordClickTarget;
      } else {
        const distToStart = Math.abs(word.start - draftStartSec);
        const distToEnd = Math.abs(word.end - draftEndSec);
        targetHandle = distToStart <= distToEnd ? "start" : "end";
      }

      if (targetHandle === "start") {
        const next = applyBounds(word.start, draftEndSec, "start", false);
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: false,
          isManualOverride: true,
        });
      } else {
        const next = applyBounds(draftStartSec, word.end, "end", false);
        void onCommit?.({
          startSec: next.startSec,
          endSec: next.endSec,
          bypassSnap: false,
          isManualOverride: true,
        });
      }
    },
    [wordClickTarget, draftStartSec, draftEndSec, applyBounds, onCommit],
  );

  const handleTimecodeSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const parsedStart = parseTimecodeToSec(startInput);
      const parsedEnd = parseTimecodeToSec(endInput);
      if (parsedStart === null) {
        setLocalError("Enter start time as mm:ss.mmm (for example 04:15.000).");
        return;
      }
      if (parsedEnd === null) {
        setLocalError("Enter end time as mm:ss.mmm (for example 05:02.500).");
        return;
      }
      if (parsedEnd <= parsedStart) {
        setLocalError("End time must come after start time.");
        return;
      }
      if (parsedEnd - parsedStart < minDurationSec) {
        setLocalError(`Clip must be at least ${minDurationSec} seconds long.`);
        return;
      }
      if (parsedEnd - parsedStart > maxDurationSec) {
        setLocalError(`Clip can be at most ${maxDurationSec} seconds long.`);
        return;
      }
      if (videoDurationSec > 0 && parsedEnd > videoDurationSec + 1e-6) {
        setLocalError(
          `Clip end cannot exceed video duration (${formatSecToTimecode(videoDurationSec)}).`,
        );
        return;
      }

      const next = applyBounds(parsedStart, parsedEnd, "both", !magneticSnap || shiftHeld);
      void onCommit?.({
        startSec: next.startSec,
        endSec: next.endSec,
        bypassSnap: next.bypassSnap,
        isManualOverride: true,
      });
    },
    [
      startInput,
      endInput,
      minDurationSec,
      maxDurationSec,
      videoDurationSec,
      applyBounds,
      magneticSnap,
      shiftHeld,
      onCommit,
    ],
  );

  const handleResetToAi = useCallback(() => {
    if (aiStartSec === undefined || aiEndSec === undefined) return;
    const next = applyBounds(aiStartSec, aiEndSec, "both", true);
    void onCommit?.({
      startSec: next.startSec,
      endSec: next.endSec,
      bypassSnap: true,
      isManualOverride: false,
    });
  }, [aiStartSec, aiEndSec, applyBounds, onCommit]);

  const startPct = Math.max(
    0,
    Math.min(100, ((draftStartSec - windowStartSec) / windowDurationSec) * 100),
  );
  const endPct = Math.max(
    startPct,
    Math.min(100, ((draftEndSec - windowStartSec) / windowDurationSec) * 100),
  );
  const clipDurationSec = Math.max(0, draftEndSec - draftStartSec);
  const isModifiedFromAi =
    aiStartSec !== undefined &&
    aiEndSec !== undefined &&
    (Math.abs(draftStartSec - aiStartSec) > 0.01 || Math.abs(draftEndSec - aiEndSec) > 0.01);

  return (
    <div
      className="timeline-trimmer rounded-lg border border-zinc-800 bg-zinc-950/90 p-3 text-xs text-zinc-200 shadow-sm"
      data-testid="timeline-trimmer"
    >
      {/* Header Bar: Timecodes, Duration, Magnetic Snap toggle, Reset to AI */}
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-100">Boundary Trimmer</span>
          <span
            className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-300"
            data-testid="trimmer-duration-badge"
          >
            Duration: {clipDurationSec.toFixed(1)}s
          </span>
          {lastSnappedHandle !== null && (
            <span
              className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
              data-testid="trimmer-snap-indicator"
            >
              Snapped to word {lastSnappedHandle}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              checked={magneticSnap && !shiftHeld}
              onChange={(e) => setMagneticSnap(e.target.checked)}
              data-testid="trimmer-magnetic-snap-toggle"
              className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-emerald-500"
            />
            <span>Magnetic Word Snap (±0.2s)</span>
          </label>
          <span className="text-[10px] text-zinc-500" title="Hold Shift while dragging for 1/30s frame accuracy">
            (Hold Shift for 1/30s frame step)
          </span>
          {isModifiedFromAi && (
            <button
              type="button"
              onClick={handleResetToAi}
              disabled={busy}
              data-testid="trimmer-reset-ai"
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Reset to AI Selection
            </button>
          )}
        </div>
      </div>

      {/* Interactive Waveform + Filmstrip Track with Dual Draggable Handles */}
      <div
        ref={trackRef}
        data-testid="trimmer-track"
        className="relative mb-3 h-16 w-full select-none overflow-hidden rounded-md border border-zinc-800 bg-zinc-900"
      >
        {/* Optional Video Filmstrip Sprite Layer */}
        {filmstripThumbnails && filmstripThumbnails.length > 0 && (
          <div
            className="pointer-events-none absolute inset-0 flex opacity-35"
            data-testid="trimmer-filmstrip"
          >
            {filmstripThumbnails.map((src, idx) => (
              <img
                key={`${src}-${String(idx)}`}
                src={src}
                alt=""
                className="h-full flex-1 object-cover"
              />
            ))}
          </div>
        )}

        {/* Audio Waveform Bars */}
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-between gap-[2px] px-1"
          data-testid="trimmer-waveform"
        >
          {peaks.map((peak, idx) => {
            const barPct = ((idx + 0.5) / peaks.length) * 100;
            const inActiveClip = barPct >= startPct && barPct <= endPct;
            const heightPct = Math.max(12, Math.min(95, Math.round(peak * 100)));
            return (
              <div
                key={idx}
                style={{ height: `${String(heightPct)}%` }}
                className={`flex-1 rounded-full transition-colors ${
                  inActiveClip ? "bg-emerald-400/85" : "bg-zinc-600/40"
                }`}
              />
            );
          })}
        </div>

        {/* Word Boundary Tick Markers inside Track */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2">
          {windowWords.map((w, idx) => {
            const left = ((w.start - windowStartSec) / windowDurationSec) * 100;
            if (left < 0 || left > 100) return null;
            return (
              <div
                key={w.id ?? `${w.text}-${String(idx)}`}
                style={{ left: `${String(left)}%` }}
                className="absolute bottom-0 h-1.5 w-[1px] bg-zinc-400/45"
                title={`${w.text} (${formatSecToTimecode(w.start)})`}
              />
            );
          })}
        </div>

        {/* Dimmed Left & Right Excluded Masks */}
        <div
          style={{ width: `${String(startPct)}%` }}
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
        />
        <div
          style={{ left: `${String(endPct)}%`, width: `${String(Math.max(0, 100 - endPct))}%` }}
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
        />

        {/* Highlighted Active Clip Window Border */}
        <div
          style={{
            left: `${String(startPct)}%`,
            width: `${String(Math.max(0.5, endPct - startPct))}%`,
          }}
          className="pointer-events-none absolute inset-y-0 border-y-2 border-emerald-400/90 bg-emerald-500/10"
          data-testid="trimmer-active-window"
        />

        {/* Draggable Left (Start) Handle */}
        <button
          type="button"
          role="slider"
          aria-label="Clip start handle"
          aria-valuemin={0}
          aria-valuemax={Number(draftEndSec.toFixed(3))}
          aria-valuenow={Number(draftStartSec.toFixed(3))}
          aria-valuetext={formatSecToTimecode(draftStartSec)}
          disabled={busy}
          data-testid="trimmer-handle-start"
          style={{ left: `calc(${String(startPct)}% - 8px)` }}
          onPointerDown={(e) => {
            e.preventDefault();
            setShiftHeld(Boolean(e.shiftKey || e.altKey));
            setDraggingHandle("start");
            seekVideoInstant(draftStartSec);
          }}
          onKeyDown={(e) => handleKeyDown("start", e)}
          className=" absolute inset-y-0 z-10 flex w-4 cursor-ew-resize items-center justify-center rounded-l bg-emerald-400 text-[10px] font-bold text-zinc-950 shadow hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
          title={`Start: ${formatSecToTimecode(draftStartSec)} (Drag or use Left/Right arrows; hold Shift for frame accuracy)`}
        >
          ◄
        </button>

        {/* Draggable Right (End) Handle */}
        <button
          type="button"
          role="slider"
          aria-label="Clip end handle"
          aria-valuemin={Number(draftStartSec.toFixed(3))}
          aria-valuemax={Number((videoDurationSec || windowEndSec).toFixed(3))}
          aria-valuenow={Number(draftEndSec.toFixed(3))}
          aria-valuetext={formatSecToTimecode(draftEndSec)}
          disabled={busy}
          data-testid="trimmer-handle-end"
          style={{ left: `calc(${String(endPct)}% - 8px)` }}
          onPointerDown={(e) => {
            e.preventDefault();
            setShiftHeld(Boolean(e.shiftKey || e.altKey));
            setDraggingHandle("end");
            seekVideoInstant(draftEndSec);
          }}
          onKeyDown={(e) => handleKeyDown("end", e)}
          className="absolute inset-y-0 z-10 flex w-4 cursor-ew-resize items-center justify-center rounded-r bg-emerald-400 text-[10px] font-bold text-zinc-950 shadow hover:bg-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
          title={`End: ${formatSecToTimecode(draftEndSec)} (Drag or use Left/Right arrows; hold Shift for frame accuracy)`}
        >
          ►
        </button>
      </div>

      {/* Timecode Inputs & Quick-Nudge Buttons */}
      <form
        onSubmit={handleTimecodeSubmit}
        className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2"
        data-testid="trimmer-timecode-form"
      >
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-zinc-800/80 bg-zinc-900/60 p-1.5">
          <label className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-300">
            <span className="font-sans text-zinc-400">Start:</span>
            <input
              type="text"
              aria-label="Start timecode"
              value={startInput}
              disabled={busy}
              onChange={(e) => setStartInput(e.target.value)}
              data-testid="trimmer-input-start"
              className="w-24 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100"
            />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("start", -2.0)}
              data-testid="trimmer-nudge-start-minus-2"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              -2.0s
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("start", -0.5)}
              data-testid="trimmer-nudge-start-minus-05"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              -0.5s
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("start", 0.5)}
              data-testid="trimmer-nudge-start-plus-05"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              +0.5s
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-zinc-800/80 bg-zinc-900/60 p-1.5">
          <label className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-300">
            <span className="font-sans text-zinc-400">End:</span>
            <input
              type="text"
              aria-label="End timecode"
              value={endInput}
              disabled={busy}
              onChange={(e) => setEndInput(e.target.value)}
              data-testid="trimmer-input-end"
              className="w-24 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-100"
            />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("end", -0.5)}
              data-testid="trimmer-nudge-end-minus-05"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              -0.5s
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("end", 0.5)}
              data-testid="trimmer-nudge-end-plus-05"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              +0.5s
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleNudge("end", 3.5)}
              data-testid="trimmer-nudge-end-plus-35"
              className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] hover:bg-zinc-700"
            >
              +3.5s
            </button>
            <button
              type="submit"
              disabled={busy}
              data-testid="trimmer-apply-timecodes"
              className="ml-1 rounded bg-emerald-500 px-2 py-0.5 font-sans text-[11px] font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
          </div>
        </div>
      </form>

      {/* Text-Linked Transcript Word Strip (Click a word to jump Start/End handle) */}
      {windowWords.length > 0 && (
        <div
          className="mb-2 rounded border border-zinc-800/80 bg-zinc-900/50 p-2"
          data-testid="trimmer-transcript-words"
        >
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-zinc-400">
            <span>
              Text-linked trim: click any word to align boundary ({slicedWords.length} words in
              clip)
            </span>
            <div className="flex items-center gap-1">
              <span>Click sets:</span>
              {(["auto", "start", "end"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setWordClickTarget(mode)}
                  data-testid={`trimmer-word-mode-${mode}`}
                  className={`rounded px-1.5 py-0.5 text-[10px] capitalize ${
                    wordClickTarget === mode
                      ? "bg-emerald-500/25 font-semibold text-emerald-300"
                      : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto leading-relaxed">
            {windowWords.map((w, idx) => {
              const mid = (w.start + w.end) / 2;
              const included = mid >= draftStartSec - 1e-6 && mid <= draftEndSec + 1e-6;
              return (
                <button
                  key={w.id ?? `${w.text}-${String(idx)}`}
                  type="button"
                  disabled={busy}
                  onClick={() => handleWordClick(w)}
                  data-testid={`trimmer-word-${String(idx)}`}
                  data-word-included={included ? "true" : "false"}
                  className={`rounded px-1 py-0.5 text-left text-[11px] transition-colors ${
                    included
                      ? "bg-emerald-500/20 font-medium text-emerald-100 hover:bg-emerald-500/35"
                      : "text-zinc-500 line-through hover:bg-zinc-800 hover:text-zinc-300"
                  }`}
                  title={`${formatSecToTimecode(w.start)} – ${formatSecToTimecode(w.end)}`}
                >
                  {w.text}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Real-Time Re-Sliced Subtitle Lines Preview */}
      {slicedLines.length > 0 && (
        <div
          className="rounded border border-zinc-800/60 bg-zinc-900/30 px-2 py-1.5 text-[11px] text-zinc-300"
          data-testid="trimmer-subtitle-preview"
        >
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Live Caption Preview ({slicedLines.length}{" "}
            {slicedLines.length === 1 ? "line" : "lines"})
          </div>
          <div className="space-y-0.5">
            {slicedLines.slice(0, 3).map((line, idx) => (
              <div key={idx} className="truncate font-sans text-zinc-200">
                <span className="mr-1.5 font-mono text-[10px] text-zinc-500">
                  [{formatSecToTimecode(line.sourceStartSec)}]
                </span>
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {(localError ?? errorMessage) && (
        <p
          role="alert"
          data-testid="trimmer-error"
          className="mt-2 text-[11px] font-medium text-rose-400"
        >
          {localError ?? errorMessage}
        </p>
      )}
    </div>
  );
}

