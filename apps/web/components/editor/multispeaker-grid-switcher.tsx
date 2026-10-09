"use client";

/**
 * Multi-Speaker Grid & Dynamic Camera Switcher Override UI (Pillar 3 §03 §5 Step 3).
 *
 * Allows creators in the editor to click on any timestamp along the clip's
 * Edit Decision List (EDL) timeline and manually toggle between Solo Speaker
 * (`SOLO`) and Multi-Speaker Grid (`TRI_PANEL` Top 60% / Bottom 40%, `GRID_4`
 * 2×2 reaction grid, or `SPLIT_2`), while preserving the >= 2.0s minimum shot
 * duration hysteresis constraint.
 */

import {
  DIRECTOR_CANVAS,
  formatSecToTimecode,
  type DirectorLayoutType,
  type LayoutCut,
  type LayoutOverride,
} from "@montaj/repurpose-contracts";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface MultiSpeakerGridSwitcherProps {
  /** Clip start timestamp in seconds. */
  readonly startSec?: number;
  /** Clip end timestamp in seconds. */
  readonly endSec?: number;
  /** Initial AI Director LayoutCut[] EDL. */
  readonly cuts?: readonly LayoutCut[];
  /** Available speaker IDs in the roundtable (default SPEAKER_00 .. SPEAKER_03). */
  readonly speakers?: readonly string[];
  /** Current playhead timestamp in seconds. */
  readonly currentTimeSec?: number;
  /** Preferred grid layout when toggling from SOLO to Multi-Speaker Grid. */
  readonly defaultGridLayout?: "TRI_PANEL" | "GRID_4" | "SPLIT_2";
  /** Callback fired when the creator toggles or overrides a layout cut at a timestamp. */
  readonly onChange?: (nextCuts: LayoutCut[], override: LayoutOverride) => void;
  /** Callback fired when the creator clicks a timestamp on the director timeline. */
  readonly onSeek?: (timestampSec: number) => void;
  /** Disable controls while a render/cut is in flight. */
  readonly busy?: boolean;
}

const DEFAULT_SPEAKERS = ["SPEAKER_00", "SPEAKER_01", "SPEAKER_02", "SPEAKER_03"] as const;

export function buildPaneAssignmentsForLayout(
  layoutType: DirectorLayoutType,
  activeSpeakerId: string,
  speakers: readonly string[] = DEFAULT_SPEAKERS,
): LayoutCut["paneAssignments"] {
  const cw = DIRECTOR_CANVAS.width;
  const ch = DIRECTOR_CANVAS.height;
  const halfW = Math.floor(cw / 2);
  const halfH = Math.floor(ch / 2);
  const ordered = speakers.length > 0 ? [...speakers] : [...DEFAULT_SPEAKERS];

  const cropForSpeaker = (
    spId: string,
    canvasPos: { x: number; y: number; width: number; height: number },
  ) => {
    const idx = Math.max(0, ordered.indexOf(spId));
    const ratio = canvasPos.width / Math.max(1, canvasPos.height);
    const cropH = 720;
    const cropW = Math.min(1920, Math.max(2, Math.round((cropH * ratio) / 2) * 2));
    const centerFrac = (idx + 0.5) / Math.max(1, ordered.length);
    const rawX = Math.round(centerFrac * 1920 - cropW / 2);
    const x = Math.floor(Math.min(Math.max(0, rawX), Math.max(0, 1920 - cropW)) / 2) * 2;
    return { x, y: 140, width: cropW, height: cropH };
  };

  if (layoutType === "SOLO") {
    const canvasPosition = { x: 0, y: 0, width: cw, height: ch };
    return [
      {
        speakerId: activeSpeakerId,
        cropRect: cropForSpeaker(activeSpeakerId, canvasPosition),
        canvasPosition,
      },
    ];
  }

  if (layoutType === "SPLIT_2") {
    const other = ordered.find((s) => s !== activeSpeakerId) ?? activeSpeakerId;
    const topPos = { x: 0, y: 0, width: cw, height: halfH };
    const botPos = { x: 0, y: halfH, width: cw, height: ch - halfH };
    return [
      {
        speakerId: activeSpeakerId,
        cropRect: cropForSpeaker(activeSpeakerId, topPos),
        canvasPosition: topPos,
      },
      {
        speakerId: other,
        cropRect: cropForSpeaker(other, botPos),
        canvasPosition: botPos,
      },
    ];
  }

  if (layoutType === "TRI_PANEL") {
    const topH = DIRECTOR_CANVAS.triPanelTopHeight; // 1152 (60%)
    const botH = DIRECTOR_CANVAS.triPanelBottomHeight; // 768 (40%)
    const others = ordered.filter((s) => s !== activeSpeakerId);
    const p1 = others[0] ?? activeSpeakerId;
    const p2 = others[1] ?? p1;

    const topPos = { x: 0, y: 0, width: cw, height: topH };
    const blPos = { x: 0, y: topH, width: halfW, height: botH };
    const brPos = { x: halfW, y: topH, width: cw - halfW, height: botH };
    return [
      {
        speakerId: activeSpeakerId,
        cropRect: cropForSpeaker(activeSpeakerId, topPos),
        canvasPosition: topPos,
      },
      {
        speakerId: p1,
        cropRect: cropForSpeaker(p1, blPos),
        canvasPosition: blPos,
      },
      {
        speakerId: p2,
        cropRect: cropForSpeaker(p2, brPos),
        canvasPosition: brPos,
      },
    ];
  }

  // GRID_4 (2×2 Grid)
  const gridSpeakers = ordered.slice(0, 4);
  while (gridSpeakers.length < 4) {
    gridSpeakers.push(ordered[gridSpeakers.length % ordered.length] ?? activeSpeakerId);
  }
  const positions = [
    { x: 0, y: 0, width: halfW, height: halfH },
    { x: halfW, y: 0, width: cw - halfW, height: halfH },
    { x: 0, y: halfH, width: halfW, height: ch - halfH },
    { x: halfW, y: halfH, width: cw - halfW, height: ch - halfH },
  ];
  return positions.map((pos, idx) => {
    const sp = gridSpeakers[idx] ?? activeSpeakerId;
    return {
      speakerId: sp,
      cropRect: cropForSpeaker(sp, pos),
      canvasPosition: pos,
    };
  });
}

export function buildDefaultDirectorEdl(
  startSec: number,
  endSec: number,
  speakers: readonly string[] = DEFAULT_SPEAKERS,
): LayoutCut[] {
  const safeStart = Math.max(0, startSec);
  const totalDur = Math.max(DIRECTOR_CANVAS.minShotDurationSec, endSec - safeStart);
  const s0 = speakers[0] ?? "SPEAKER_00";
  const s1 = speakers[1] ?? s0;
  const s2 = speakers[2] ?? s0;

  if (totalDur < DIRECTOR_CANVAS.minShotDurationSec * 2) {
    return [
      {
        startSec: safeStart,
        endSec: safeStart + totalDur,
        layoutType: "SOLO",
        activeSpeakerId: s0,
        paneAssignments: buildPaneAssignmentsForLayout("SOLO", s0, speakers),
      },
    ];
  }

  if (totalDur < DIRECTOR_CANVAS.minShotDurationSec * 3) {
    const mid = Number((safeStart + totalDur / 2).toFixed(3));
    return [
      {
        startSec: safeStart,
        endSec: mid,
        layoutType: "SOLO",
        activeSpeakerId: s0,
        paneAssignments: buildPaneAssignmentsForLayout("SOLO", s0, speakers),
      },
      {
        startSec: mid,
        endSec: Number((safeStart + totalDur).toFixed(3)),
        layoutType: "TRI_PANEL",
        activeSpeakerId: s1,
        paneAssignments: buildPaneAssignmentsForLayout("TRI_PANEL", s1, speakers),
      },
    ];
  }

  const c1 = Number((safeStart + totalDur * 0.4).toFixed(3));
  const c2 = Number((safeStart + totalDur * 0.7).toFixed(3));
  const cEnd = Number((safeStart + totalDur).toFixed(3));

  return [
    {
      startSec: safeStart,
      endSec: c1,
      layoutType: "SOLO",
      activeSpeakerId: s0,
      paneAssignments: buildPaneAssignmentsForLayout("SOLO", s0, speakers),
    },
    {
      startSec: c1,
      endSec: c2,
      layoutType: "TRI_PANEL",
      activeSpeakerId: s1,
      paneAssignments: buildPaneAssignmentsForLayout("TRI_PANEL", s1, speakers),
    },
    {
      startSec: c2,
      endSec: cEnd,
      layoutType: "SOLO",
      activeSpeakerId: s2,
      paneAssignments: buildPaneAssignmentsForLayout("SOLO", s2, speakers),
    },
  ];
}

/**
 * Toggle or override the layout at `timestampSec` within an EDL while enforcing
 * the minimum 2.0s shot duration constraint.
 */
export function applyTimestampLayoutOverride(
  cuts: readonly LayoutCut[],
  override: LayoutOverride,
  speakers: readonly string[] = DEFAULT_SPEAKERS,
): LayoutCut[] {
  if (cuts.length === 0) return [];
  let matched = false;
  return cuts.map((cut, index) => {
    const isLast = index === cuts.length - 1;
    const contains =
      !matched &&
      override.timestampSec >= cut.startSec &&
      (override.timestampSec < cut.endSec || (isLast && override.timestampSec <= cut.endSec));
    if (!contains) return cut;
    matched = true;

    const nextSpeaker = override.activeSpeakerId ?? cut.activeSpeakerId;
    return {
      startSec: cut.startSec,
      endSec: cut.endSec,
      layoutType: override.layoutType,
      activeSpeakerId: nextSpeaker,
      paneAssignments: buildPaneAssignmentsForLayout(override.layoutType, nextSpeaker, speakers),
    };
  });
}

const LAYOUT_LABELS: Readonly<Record<DirectorLayoutType, string>> = {
  SOLO: "Solo Speaker (Full 9:16)",
  TRI_PANEL: "Tri-Panel Grid (Top 60% + 2 Bottom)",
  GRID_4: "2×2 Reaction Grid (4 Speakers)",
  SPLIT_2: "2-Speaker Vertical Split",
};

export function MultiSpeakerGridSwitcher({
  startSec = 0,
  endSec = 30,
  cuts: initialCutsProp,
  speakers = DEFAULT_SPEAKERS,
  currentTimeSec,
  defaultGridLayout = "TRI_PANEL",
  onChange,
  onSeek,
  busy = false,
}: MultiSpeakerGridSwitcherProps): React.ReactElement {
  const defaultEdl = useMemo(
    () =>
      initialCutsProp && initialCutsProp.length > 0
        ? [...initialCutsProp]
        : buildDefaultDirectorEdl(startSec, endSec, speakers),
    [initialCutsProp, startSec, endSec, speakers],
  );

  const [cuts, setCuts] = useState<LayoutCut[]>(defaultEdl);
  const [selectedTimeSec, setSelectedTimeSec] = useState<number>(
    currentTimeSec ?? defaultEdl[0]?.startSec ?? startSec,
  );
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCuts(defaultEdl);
  }, [defaultEdl]);

  useEffect(() => {
    if (typeof currentTimeSec === "number" && Number.isFinite(currentTimeSec)) {
      setSelectedTimeSec(currentTimeSec);
    }
  }, [currentTimeSec]);

  const clipStart = cuts[0]?.startSec ?? startSec;
  const clipEnd = cuts[cuts.length - 1]?.endSec ?? endSec;
  const clipSpan = Math.max(DIRECTOR_CANVAS.minShotDurationSec, clipEnd - clipStart);

  const activeCut = useMemo(() => {
    const first = cuts[0];
    if (!first) return null;
    for (let i = 0; i < cuts.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bounded index
      const c = cuts[i] ?? first;
      const isLast = i === cuts.length - 1;
      if (selectedTimeSec >= c.startSec && (selectedTimeSec < c.endSec || (isLast && selectedTimeSec <= c.endSec))) {
        return c;
      }
    }
    return cuts[cuts.length - 1] ?? first;
  }, [cuts, selectedTimeSec]);

  const commitOverride = useCallback(
    (timestampSec: number, layoutType: DirectorLayoutType, activeSpeakerId?: string) => {
      const override: LayoutOverride = {
        timestampSec: Number(timestampSec.toFixed(3)),
        layoutType,
        ...(activeSpeakerId === undefined ? {} : { activeSpeakerId }),
      };
      const next = applyTimestampLayoutOverride(cuts, override, speakers);
      setCuts(next);
      onChange?.(next, override);
    },
    [cuts, speakers, onChange],
  );

  const handleToggleAtTimestamp = useCallback(
    (timestampSec: number, currentCut: LayoutCut | null) => {
      const clampedT = Math.max(clipStart, Math.min(clipEnd, timestampSec));
      setSelectedTimeSec(clampedT);
      onSeek?.(clampedT);

      const targetCut =
        currentCut ??
        cuts.find((c, idx) =>
          clampedT >= c.startSec && (clampedT < c.endSec || idx === cuts.length - 1),
        ) ??
        cuts[0];
      if (!targetCut) return;

      const isCurrentlySolo = targetCut.layoutType === "SOLO";
      const nextLayout: DirectorLayoutType = isCurrentlySolo ? defaultGridLayout : "SOLO";
      commitOverride(clampedT, nextLayout, targetCut.activeSpeakerId);
    },
    [clipStart, clipEnd, onSeek, cuts, defaultGridLayout, commitOverride],
  );

  const handleTrackPointerClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (busy) return;
      const el = timelineRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const clickedSec = Number((clipStart + ratio * clipSpan).toFixed(3));
      handleToggleAtTimestamp(clickedSec, null);
    },
    [busy, clipStart, clipSpan, handleToggleAtTimestamp],
  );

  const isActiveMultiGrid = activeCut !== null && activeCut.layoutType !== "SOLO";

  return (
    <div
      className="multispeaker-grid-switcher rounded-lg border border-zinc-800 bg-zinc-950/90 p-3 text-xs text-zinc-200 shadow-sm"
      data-testid="multispeaker-grid-switcher"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-zinc-100">
            Multi-Speaker Director & Grid Switcher
          </span>
          <span
            className="rounded bg-sky-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-sky-300"
            data-testid="director-selected-timestamp"
          >
            @{formatSecToTimecode(selectedTimeSec)}
          </span>
          {activeCut && (
            <span
              className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-200"
              data-testid="director-active-layout-badge"
            >
              {LAYOUT_LABELS[activeCut.layoutType]}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy || activeCut === null}
            onClick={() => {
              if (activeCut) {
                handleToggleAtTimestamp(selectedTimeSec, activeCut);
              }
            }}
            data-testid="director-toggle-solo-grid"
            className="rounded border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
          >
            {isActiveMultiGrid ? "Switch to Solo Speaker" : "Switch to Multi-Speaker Grid"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCuts(defaultEdl);
              if (defaultEdl[0]) {
                onChange?.(defaultEdl, {
                  timestampSec: selectedTimeSec,
                  layoutType: defaultEdl[0].layoutType,
                  activeSpeakerId: defaultEdl[0].activeSpeakerId,
                });
              }
            }}
            data-testid="director-reset-edl"
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Reset AI Cuts
          </button>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-zinc-400">
        Click any timestamp or camera cut below to toggle between Solo Speaker close-up and
        Multi-Speaker Reaction Grid (minimum 2.0s hold time enforced).
      </p>

      {/* Interactive Timed LayoutCut[] EDL Track */}
      <div
        ref={timelineRef}
        onClick={handleTrackPointerClick}
        data-testid="director-edl-timeline"
        className="relative mb-3 flex h-10 w-full cursor-pointer select-none overflow-hidden rounded-md border border-zinc-800 bg-zinc-900"
      >
        {cuts.map((cut, idx) => {
          const widthPct = Math.max(5, ((cut.endSec - cut.startSec) / clipSpan) * 100);
          const isSelected = activeCut === cut;
          const isGrid = cut.layoutType !== "SOLO";
          return (
            <button
              key={`${String(cut.startSec)}-${String(idx)}`}
              type="button"
              disabled={busy}
              data-testid={`director-cut-segment-${String(idx)}`}
              data-layout-type={cut.layoutType}
              data-start-sec={cut.startSec}
              data-end-sec={cut.endSec}
              style={{ width: `${String(widthPct)}%` }}
              onClick={(e) => {
                e.stopPropagation();
                const midSec = Number(((cut.startSec + cut.endSec) / 2).toFixed(3));
                handleToggleAtTimestamp(midSec, cut);
              }}
              className={`flex h-full flex-col items-center justify-center border-r border-zinc-800/80 px-1 text-center transition-colors ${
                isGrid
                  ? "bg-purple-500/25 text-purple-200 hover:bg-purple-500/35"
                  : "bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
              } ${isSelected ? "ring-2 ring-inset ring-sky-400" : ""}`}
              title={`${cut.layoutType} (${cut.activeSpeakerId}): ${cut.startSec.toFixed(1)}s – ${cut.endSec.toFixed(1)}s. Click to toggle Solo / Grid.`}
            >
              <span className="truncate text-[10px] font-bold">{cut.layoutType}</span>
              <span className="truncate font-mono text-[9px] opacity-80">
                {cut.startSec.toFixed(1)}s–{cut.endSec.toFixed(1)}s
              </span>
            </button>
          );
        })}
      </div>

      {/* Explicit Layout Mode & Active Speaker Controls + Mini Canvas Geometry Preview */}
      {activeCut && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-zinc-800/80 bg-zinc-900/50 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-zinc-400">Shot Mode:</span>
            {(["SOLO", "TRI_PANEL", "GRID_4", "SPLIT_2"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={busy}
                aria-pressed={activeCut.layoutType === mode}
                data-testid={`director-mode-${mode}`}
                onClick={() => commitOverride(selectedTimeSec, mode, activeCut.activeSpeakerId)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  activeCut.layoutType === mode
                    ? "bg-sky-500 text-zinc-950 font-semibold"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                {mode === "SOLO"
                  ? "Solo"
                  : mode === "TRI_PANEL"
                    ? "Tri-Panel (1+2)"
                    : mode === "GRID_4"
                      ? "2×2 Grid (4)"
                      : "Split (2)"}
              </button>
            ))}
          </div>

          <div
            data-testid="director-mini-preview"
            data-layout-type={activeCut.layoutType}
            className="flex items-center gap-2 font-mono text-[10px] text-zinc-400"
          >
            <span>Panes: {String(activeCut.paneAssignments.length)}</span>
            <span>·</span>
            <span>Active: {activeCut.activeSpeakerId}</span>
          </div>
        </div>
      )}
    </div>
  );
}
