/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Multi-Speaker Grid & Dynamic Camera Switcher Engine (Pillar 3 §03).
 *
 * Remotion-compatible `<DirectorLayout />` (and `<DirectorView />` alias)
 * multi-pane compositor, 150ms crossfade / hard-cut camera switcher, RGBA canvas
 * compositor, and FFmpeg multi-tile filtergraph builder:
 *
 * - Dynamically renders video panes (`<OffthreadVideo>`) based on the current
 *   timecode matching the active `LayoutCut` in the Director EDL (`SOLO`,
 *   `SPLIT_2`, `TRI_PANEL`, `GRID_4`).
 * - Supports Tri-Panel Stack (Active Speaker in Top 60% = 1080 × 1152, Two
 *   Panelists in Bottom 40% = two 540 × 768 tiles) and 2×2 Grid (four 540 × 960
 *   tiles) during rapid dialogue turnarounds and group reactions.
 * - Implements 150ms crossfade (`DEFAULT_CROSSFADE_DURATION_SEC = 0.15`) or
 *   hard-cut transitions between camera angles.
 * - Supports manual timestamp layout overrides (`SOLO` <-> `TRI_PANEL` / `GRID_4`).
 */

import {
  computeWordMargin,
  computeWordSpringScale,
  computeWordYOffset,
} from "@montaj/caption-styles";

import {
  DEFAULT_DIVIDER_COLOR,
  Fragment,
  OffthreadVideo,
  computePaneVideoLayout,
  findVNodeByTestId,
  findVNodesByType,
  h,
  type KineticCaptionWord,
  type PaneVideoGeometry,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export {
  DEFAULT_DIVIDER_COLOR,
  Fragment,
  OffthreadVideo,
  computePaneVideoLayout,
  findVNodeByTestId,
  findVNodesByType,
  h,
  type KineticCaptionWord,
  type PaneVideoGeometry,
  type SplitScreenStyle,
  type SplitScreenVNode,
};

export type DirectorLayoutType = "SOLO" | "SPLIT_2" | "TRI_PANEL" | "GRID_4";

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutPaneAssignment {
  readonly speakerId: string;
  readonly cropRect: LayoutRect;
  readonly canvasPosition: LayoutRect;
}

/**
 * Layout EDL Data Contract (Pillar 3 §03 §4.1).
 */
export interface LayoutCut {
  readonly startSec: number;
  readonly endSec: number;
  readonly layoutType: DirectorLayoutType;
  readonly activeSpeakerId: string;
  readonly paneAssignments: ReadonlyArray<{
    readonly speakerId: string;
    readonly cropRect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly canvasPosition: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }>;
}

export interface LayoutOverride {
  readonly timestampSec: number;
  readonly layoutType: DirectorLayoutType;
  readonly activeSpeakerId?: string;
}

export const DEFAULT_CROSSFADE_DURATION_SEC = 0.15; // 150ms crossfade transition
export const MIN_SHOT_DURATION_SEC = 2.0; // Minimum 2.0s (60 frames at 30fps) hold time

/**
 * Standard 1080 × 1920 canvas tile coordinates for `SOLO`, `SPLIT_2`, `TRI_PANEL`, and `GRID_4`.
 */
export function buildDefaultCanvasPositions(
  layoutType: DirectorLayoutType,
  canvasWidth = 1080,
  canvasHeight = 1920,
): LayoutRect[] {
  const halfW = Math.floor(canvasWidth / 2);
  const halfH = Math.floor(canvasHeight / 2);

  if (layoutType === "SOLO") {
    return [{ x: 0, y: 0, width: canvasWidth, height: canvasHeight }];
  }
  if (layoutType === "SPLIT_2") {
    return [
      { x: 0, y: 0, width: canvasWidth, height: halfH },
      { x: 0, y: halfH, width: canvasWidth, height: canvasHeight - halfH },
    ];
  }
  if (layoutType === "TRI_PANEL") {
    // Active Speaker in Top 60% (1080 × 1152), Two Panelists in Bottom 40% (2 × 540 × 768)
    const topH = Math.round((canvasHeight * 0.6) / 2) * 2;
    const botH = canvasHeight - topH;
    return [
      { x: 0, y: 0, width: canvasWidth, height: topH },
      { x: 0, y: topH, width: halfW, height: botH },
      { x: halfW, y: topH, width: canvasWidth - halfW, height: botH },
    ];
  }
  // GRID_4 (2×2 Grid)
  return [
    { x: 0, y: 0, width: halfW, height: halfH },
    { x: halfW, y: 0, width: canvasWidth - halfW, height: halfH },
    { x: 0, y: halfH, width: halfW, height: canvasHeight - halfH },
    { x: halfW, y: halfH, width: canvasWidth - halfW, height: canvasHeight - halfH },
  ];
}

function fitCropToCanvasAspect(
  baseCrop: LayoutRect,
  canvasPosition: LayoutRect,
  sourceWidth = 1920,
  sourceHeight = 1080,
): LayoutRect {
  const targetRatio = canvasPosition.width / Math.max(1, canvasPosition.height);
  const cx = baseCrop.x + baseCrop.width / 2;
  const cy = baseCrop.y + baseCrop.height / 2;

  let cropH = Math.min(sourceHeight, Math.max(240, baseCrop.height));
  let cropW = Math.round((cropH * targetRatio) / 2) * 2;
  if (cropW > sourceWidth) {
    cropW = Math.floor(sourceWidth / 2) * 2;
    cropH = Math.floor(cropW / targetRatio / 2) * 2;
  }
  cropH = Math.max(2, Math.floor(cropH / 2) * 2);
  cropW = Math.max(2, Math.floor(cropW / 2) * 2);

  const rawX = Math.round(cx - cropW / 2);
  const rawY = Math.round(cy - cropH / 2);
  const x = Math.floor(Math.min(Math.max(0, rawX), Math.max(0, sourceWidth - cropW)) / 2) * 2;
  const y = Math.floor(Math.min(Math.max(0, rawY), Math.max(0, sourceHeight - cropH)) / 2) * 2;

  return { x, y, width: cropW, height: cropH };
}

/**
 * Apply a manual timestamp layout override (e.g. toggling between `SOLO` and
 * `TRI_PANEL` / `GRID_4`) to an existing `LayoutCut[]` EDL.
 */
export function applyLayoutOverrideToEdl(
  cuts: readonly LayoutCut[],
  override: LayoutOverride,
  options: {
    readonly sourceWidth?: number;
    readonly sourceHeight?: number;
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
  } = {},
): LayoutCut[] {
  if (cuts.length === 0) return [];
  const sourceWidth = options.sourceWidth ?? 1920;
  const sourceHeight = options.sourceHeight ?? 1080;
  const canvasWidth = options.canvasWidth ?? 1080;
  const canvasHeight = options.canvasHeight ?? 1920;

  // Collect known speaker crops across the EDL so switching SOLO -> TRI_PANEL/GRID_4
  // populates all panelist tiles with their real face crops
  const knownCrops = new Map<string, LayoutRect>();
  for (const cut of cuts) {
    for (const pane of cut.paneAssignments) {
      if (!knownCrops.has(pane.speakerId)) {
        knownCrops.set(pane.speakerId, pane.cropRect);
      }
    }
  }
  const speakerIds = [...knownCrops.keys()];
  while (speakerIds.length < 4) {
    const idx = speakerIds.length;
    const spId = `SPEAKER_0${String(idx)}`;
    if (!knownCrops.has(spId)) {
      knownCrops.set(spId, {
        x: Math.floor(((idx * 0.24 + 0.08) * sourceWidth) / 2) * 2,
        y: 140,
        width: 480,
        height: 720,
      });
      speakerIds.push(spId);
    }
  }

  let matched = false;
  return cuts.map((cut, index) => {
    const isLast = index === cuts.length - 1;
    const contains =
      !matched &&
      override.timestampSec >= cut.startSec &&
      (override.timestampSec < cut.endSec || (isLast && override.timestampSec <= cut.endSec));
    if (!contains) return cut;
    matched = true;

    const activeSpeakerId = override.activeSpeakerId ?? cut.activeSpeakerId;
    const canvasPositions = buildDefaultCanvasPositions(
      override.layoutType,
      canvasWidth,
      canvasHeight,
    );
    const otherSpeakers = speakerIds.filter((id) => id !== activeSpeakerId);
    const orderedForCut =
      override.layoutType === "GRID_4"
        ? speakerIds.slice(0, 4)
        : [activeSpeakerId, ...otherSpeakers];

    const paneAssignments = canvasPositions.map((canvasPos, paneIdx) => {
      const spId = orderedForCut[paneIdx % orderedForCut.length] ?? activeSpeakerId;
      const baseCrop = knownCrops.get(spId) ?? {
        x: 420,
        y: 120,
        width: 608,
        height: 840,
      };
      return {
        speakerId: spId,
        cropRect: fitCropToCanvasAspect(baseCrop, canvasPos, sourceWidth, sourceHeight),
        canvasPosition: canvasPos,
      };
    });

    return {
      startSec: cut.startSec,
      endSec: cut.endSec,
      layoutType: override.layoutType,
      activeSpeakerId,
      paneAssignments,
    };
  });
}

export interface ResolvedDirectorShot {
  readonly activeCut: LayoutCut;
  readonly activeCutIndex: number;
  readonly previousCut: LayoutCut | null;
  readonly inTransition: boolean;
  readonly transitionAlpha: number; // 0.0 (start of crossfade) .. 1.0 (fully settled on activeCut)
}

/**
 * Resolve the active `LayoutCut` at `currentTimeSec` and compute the 150ms
 * crossfade (or hard-cut) transition state relative to the preceding cut.
 */
export function resolveActiveLayoutCut(
  cuts: readonly LayoutCut[],
  currentTimeSec: number,
  options: {
    readonly transitionMode?: "crossfade" | "hard";
    readonly crossfadeDurationSec?: number;
    readonly overrides?: readonly LayoutOverride[];
  } = {},
): ResolvedDirectorShot | null {
  let effectiveCuts = [...cuts];
  if (options.overrides && options.overrides.length > 0) {
    for (const ov of options.overrides) {
      effectiveCuts = applyLayoutOverrideToEdl(effectiveCuts, ov);
    }
  }
  const first = effectiveCuts[0];
  if (first === undefined) return null;

  const t = Math.max(0, currentTimeSec);
  let activeIndex = 0;
  for (let i = 0; i < effectiveCuts.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bounded index
    const candidate = effectiveCuts[i] ?? first;
    const isLast = i === effectiveCuts.length - 1;
    if (t >= candidate.startSec && (t < candidate.endSec || (isLast && t <= candidate.endSec))) {
      activeIndex = i;
      break;
    }
    if (t >= candidate.endSec) {
      activeIndex = i;
    }
  }

  // eslint-disable-next-line security/detect-object-injection -- bounded index
  const activeCut = effectiveCuts[activeIndex] ?? first;
  const prev = activeIndex > 0 ? (effectiveCuts[activeIndex - 1] ?? null) : null;
  const mode = options.transitionMode ?? "crossfade";
  const crossfadeDur = Math.max(0, options.crossfadeDurationSec ?? DEFAULT_CROSSFADE_DURATION_SEC);

  const shotChanged =
    prev !== null &&
    (prev.layoutType !== activeCut.layoutType ||
      prev.activeSpeakerId !== activeCut.activeSpeakerId);
  const elapsedInCut = t - activeCut.startSec;

  if (mode === "crossfade" && shotChanged && crossfadeDur > 1e-6 && elapsedInCut >= 0 && elapsedInCut < crossfadeDur) {
    const alpha = Math.min(1, Math.max(0, Math.round((elapsedInCut / crossfadeDur) * 10000) / 10000));
    return {
      activeCut,
      activeCutIndex: activeIndex,
      previousCut: prev,
      inTransition: true,
      transitionAlpha: alpha,
    };
  }

  return {
    activeCut,
    activeCutIndex: activeIndex,
    previousCut: prev,
    inTransition: false,
    transitionAlpha: 1,
  };
}

export interface DirectorLayoutProps {
  readonly src: string;
  readonly cuts: readonly LayoutCut[];
  readonly currentTimeSec?: number;
  readonly frame?: number;
  readonly fps?: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly transitionMode?: "crossfade" | "hard";
  readonly crossfadeDurationSec?: number;
  readonly dividerColor?: string;
  readonly activeSpeakerHighlight?: boolean;
  readonly overrides?: readonly LayoutOverride[];
  readonly captionText?: string;
  readonly captionWords?: readonly KineticCaptionWord[];
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
}

function renderCutLayer(
  cut: LayoutCut,
  options: {
    readonly layerTestId: string;
    readonly src: string;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly canvasWidth: number;
    readonly canvasHeight: number;
    readonly opacity: number;
    readonly dividerColor: string;
    readonly activeSpeakerHighlight: boolean;
    readonly isPrimaryAudioLayer: boolean;
    readonly startFrom?: number;
    readonly endAt?: number;
    readonly muted?: boolean;
    readonly volume?: number;
  },
): SplitScreenVNode {
  const {
    layerTestId,
    src,
    sourceWidth,
    sourceHeight,
    canvasWidth,
    canvasHeight,
    opacity,
    dividerColor,
    activeSpeakerHighlight,
    isPrimaryAudioLayer,
  } = options;

  const paneNodes = cut.paneAssignments.map((pane, idx) => {
    const isActive = pane.speakerId === cut.activeSpeakerId;
    const geom = computePaneVideoLayout(
      pane.cropRect,
      { width: sourceWidth, height: sourceHeight },
      {
        width: pane.canvasPosition.width,
        height: pane.canvasPosition.height,
        top: pane.canvasPosition.y,
        left: pane.canvasPosition.x,
      },
      {
        isActiveSpeaker: isActive,
        activeSpeakerHighlight: activeSpeakerHighlight && cut.layoutType !== "SOLO",
      },
    );

    const playAudio = isPrimaryAudioLayer && idx === 0 && !(options.muted ?? false);

    return (
      <div
        data-testid={`${layerTestId}-pane-${String(idx)}`}
        data-speaker-id={pane.speakerId}
        data-active-speaker={isActive ? "true" : "false"}
        style={{
          position: "absolute",
          left: geom.paneLeft,
          top: geom.paneTop,
          width: geom.paneWidth,
          height: geom.paneHeight,
          overflow: "hidden",
          clipPath: geom.clipPath,
          boxShadow:
            activeSpeakerHighlight && isActive && cut.layoutType !== "SOLO"
              ? "inset 0 0 0 3px rgba(56, 189, 248, 0.85)"
              : "none",
        }}
      >
        <OffthreadVideo
          data-testid={`${layerTestId}-video-${String(idx)}`}
          src={src}
          startFrom={options.startFrom}
          endAt={options.endAt}
          muted={!playAudio}
          volume={playAudio ? (options.volume ?? 1) : 0}
          style={{
            position: "absolute",
            width: geom.videoWidth,
            height: geom.videoHeight,
            left: geom.videoLeft,
            top: geom.videoTop,
            objectFit: "cover",
          }}
        />
      </div>
    );
  });

  // Aesthetic 2px grid dividers for SPLIT_2, TRI_PANEL, and GRID_4
  const dividers: SplitScreenVNode[] = [];
  if (cut.layoutType === "SPLIT_2") {
    const splitY = Math.floor(canvasHeight / 2) - 1;
    dividers.push(
      <div
        data-testid={`${layerTestId}-divider-horizontal`}
        style={{
          position: "absolute",
          left: 0,
          top: splitY,
          width: canvasWidth,
          height: 2,
          backgroundColor: dividerColor,
          zIndex: 10,
        }}
      />,
    );
  } else if (cut.layoutType === "TRI_PANEL") {
    const topH = cut.paneAssignments[0]?.canvasPosition.height ?? Math.round(canvasHeight * 0.6);
    const botH = canvasHeight - topH;
    const halfW = Math.floor(canvasWidth / 2);
    dividers.push(
      <div
        data-testid={`${layerTestId}-divider-horizontal`}
        style={{
          position: "absolute",
          left: 0,
          top: topH - 1,
          width: canvasWidth,
          height: 2,
          backgroundColor: dividerColor,
          zIndex: 10,
        }}
      />,
      <div
        data-testid={`${layerTestId}-divider-vertical`}
        style={{
          position: "absolute",
          left: halfW - 1,
          top: topH,
          width: 2,
          height: botH,
          backgroundColor: dividerColor,
          zIndex: 10,
        }}
      />,
    );
  } else if (cut.layoutType === "GRID_4") {
    const halfW = Math.floor(canvasWidth / 2);
    const halfH = Math.floor(canvasHeight / 2);
    dividers.push(
      <div
        data-testid={`${layerTestId}-divider-horizontal`}
        style={{
          position: "absolute",
          left: 0,
          top: halfH - 1,
          width: canvasWidth,
          height: 2,
          backgroundColor: dividerColor,
          zIndex: 10,
        }}
      />,
      <div
        data-testid={`${layerTestId}-divider-vertical`}
        style={{
          position: "absolute",
          left: halfW - 1,
          top: 0,
          width: 2,
          height: canvasHeight,
          backgroundColor: dividerColor,
          zIndex: 10,
        }}
      />,
    );
  }

  return (
    <div
      data-testid={layerTestId}
      data-layout-type={cut.layoutType}
      data-active-speaker-id={cut.activeSpeakerId}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: canvasWidth,
        height: canvasHeight,
        opacity,
      }}
    >
      {paneNodes}
      {dividers}
    </div>
  );
}

/**
 * Remotion Multi-Pane Compositor (`<DirectorLayout />`).
 *
 * Dynamically renders `SOLO`, `SPLIT_2`, `TRI_PANEL` (Top 60% Active Speaker +
 * Bottom 40% Two Panelists), or `GRID_4` (2×2 reaction grid) based on the active
 * `LayoutCut` at `currentTimeSec`, with 150ms crossfade or hard-cut transitions.
 */
export function DirectorLayout(props: DirectorLayoutProps): SplitScreenVNode {
  const canvasWidth = props.canvasWidth ?? 1080;
  const canvasHeight = props.canvasHeight ?? 1920;
  const sourceWidth = props.sourceWidth ?? 1920;
  const sourceHeight = props.sourceHeight ?? 1080;
  const dividerColor = props.dividerColor ?? DEFAULT_DIVIDER_COLOR;
  const activeSpeakerHighlight = props.activeSpeakerHighlight ?? true;
  const transitionMode = props.transitionMode ?? "crossfade";
  const crossfadeDurationSec = props.crossfadeDurationSec ?? DEFAULT_CROSSFADE_DURATION_SEC;

  const currentTimeSec =
    props.currentTimeSec ??
    (typeof props.frame === "number" ? props.frame / Math.max(1, props.fps ?? 30) : 0);

  const resolved = resolveActiveLayoutCut(props.cuts, currentTimeSec, {
    transitionMode,
    crossfadeDurationSec,
    overrides: props.overrides,
  });

  const activeCut: LayoutCut = resolved?.activeCut ?? {
    startSec: 0,
    endSec: Math.max(MIN_SHOT_DURATION_SEC, currentTimeSec + MIN_SHOT_DURATION_SEC),
    layoutType: "SOLO",
    activeSpeakerId: "SPEAKER_00",
    paneAssignments: [
      {
        speakerId: "SPEAKER_00",
        cropRect: { x: 656, y: 0, width: 608, height: 1080 },
        canvasPosition: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
      },
    ],
  };

  const inTransition = resolved?.inTransition ?? false;
  const transitionAlpha = resolved?.transitionAlpha ?? 1;
  const previousCut = resolved?.previousCut ?? null;

  const activeWords = (props.captionWords ?? []).map((word, index, list) => {
    const isPast = index === list.length - 1 ? currentTimeSec > word.endSec : currentTimeSec >= word.endSec;
    const isCurrent = currentTimeSec >= word.startSec && !isPast;
    const scale = isCurrent ? computeWordSpringScale(currentTimeSec, word.startSec) : 1;
    const yOffset = isCurrent ? computeWordYOffset(currentTimeSec, word.startSec, 60, -4) : 0;
    const margin = computeWordMargin(48, isCurrent, 8);
    return (
      <span
        key={index}
        data-active={isCurrent ? "true" : "false"}
        data-scale={scale.toFixed(3)}
        style={{
          display: "inline-block",
          marginRight: `${margin.toFixed(1)}px`,
          color: isCurrent ? (word.highlightColor ?? "#FFD700") : "#FFFFFF",
          transform: isCurrent
            ? `translate3d(0, ${yOffset.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`
            : "scale(1)",
          textShadow: isCurrent
            ? `0 0 20px ${word.highlightColor ?? "#FFD700"}, 0 2px 4px rgba(0,0,0,0.85)`
            : "0 2px 4px rgba(0,0,0,0.85)",
          fontWeight: 800,
          willChange: "transform, color",
        }}
      >
        {word.text}
      </span>
    );
  });

  const hasCaptions =
    (typeof props.captionText === "string" && props.captionText.trim().length > 0) ||
    activeWords.length > 0;
  const captionTopPx =
    activeCut.layoutType === "TRI_PANEL"
      ? (activeCut.paneAssignments[0]?.canvasPosition.height ?? Math.round(canvasHeight * 0.6))
      : activeCut.layoutType === "SPLIT_2" || activeCut.layoutType === "GRID_4"
        ? Math.floor(canvasHeight / 2)
        : Math.round(canvasHeight * 0.8);

  return (
    <div
      data-testid="director-layout-canvas"
      data-layout-type={activeCut.layoutType}
      data-active-speaker-id={activeCut.activeSpeakerId}
      data-transition-mode={transitionMode}
      data-in-transition={inTransition ? "true" : "false"}
      style={{
        position: "relative",
        width: canvasWidth,
        height: canvasHeight,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {inTransition && previousCut !== null
        ? renderCutLayer(previousCut, {
            layerTestId: "director-outgoing-cut-layer",
            src: props.src,
            sourceWidth,
            sourceHeight,
            canvasWidth,
            canvasHeight,
            opacity: Math.round((1 - transitionAlpha) * 10000) / 10000,
            dividerColor,
            activeSpeakerHighlight,
            isPrimaryAudioLayer: false,
            startFrom: props.startFrom,
            endAt: props.endAt,
            muted: true,
            volume: 0,
          })
        : null}

      {renderCutLayer(activeCut, {
        layerTestId: "director-active-cut-layer",
        src: props.src,
        sourceWidth,
        sourceHeight,
        canvasWidth,
        canvasHeight,
        opacity: inTransition ? transitionAlpha : 1,
        dividerColor,
        activeSpeakerHighlight,
        isPrimaryAudioLayer: true,
        startFrom: props.startFrom,
        endAt: props.endAt,
        muted: props.muted,
        volume: props.volume,
      })}

      {hasCaptions ? (
        <div
          data-testid="director-kinetic-captions"
          style={{
            position: "absolute",
            top: captionTopPx,
            left: Math.round(canvasWidth / 2),
            transform: "translate(-50%, -50%)",
            maxWidth: Math.round(canvasWidth * 0.88),
            textAlign: "center",
            zIndex: 20,
            pointerEvents: "none",
          }}
        >
          {activeWords.length > 0 ? activeWords : <span>{props.captionText ?? ""}</span>}
        </div>
      ) : null}
    </div>
  );
}

export const DirectorView = DirectorLayout;

function parseHexToRgba(hex: string | undefined): readonly [number, number, number, number] {
  const clean = (hex ?? DEFAULT_DIVIDER_COLOR).trim();
  const match = /^#([0-9a-fA-F]{6})$/.exec(clean);
  if (match === null || match[1] === undefined) {
    return [26, 26, 26, 255];
  }
  const intVal = Number.parseInt(match[1], 16);
  return [(intVal >> 16) & 0xff, (intVal >> 8) & 0xff, intVal & 0xff, 255];
}

function renderSingleCutToRgba(
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  cut: LayoutCut,
  canvasWidth: number,
  canvasHeight: number,
  dividerColor: string | undefined,
): { readonly data: Uint8Array; readonly geometries: PaneVideoGeometry[] } {
  const out = new Uint8Array(canvasWidth * canvasHeight * 4);
  const geometries: PaneVideoGeometry[] = [];

  for (const pane of cut.paneAssignments) {
    const geom = computePaneVideoLayout(
      pane.cropRect,
      { width: sourceWidth, height: sourceHeight },
      {
        width: pane.canvasPosition.width,
        height: pane.canvasPosition.height,
        top: pane.canvasPosition.y,
        left: pane.canvasPosition.x,
      },
    );
    geometries.push(geom);

    const invScale = 1 / geom.scale;
    const maxPy = Math.min(geom.paneHeight, canvasHeight - geom.paneTop);
    const maxPx = Math.min(geom.paneWidth, canvasWidth - geom.paneLeft);

    for (let py = 0; py < maxPy; py += 1) {
      const srcY = Math.min(
        sourceHeight - 1,
        Math.max(0, Math.floor((py - geom.videoTop) * invScale)),
      );
      const srcRowOffset = srcY * sourceWidth;
      const dstRowOffset = (geom.paneTop + py) * canvasWidth;

      for (let px = 0; px < maxPx; px += 1) {
        const srcX = Math.min(
          sourceWidth - 1,
          Math.max(0, Math.floor((px - geom.videoLeft) * invScale)),
        );
        const sIdx = (srcRowOffset + srcX) * 4;
        const dIdx = (dstRowOffset + geom.paneLeft + px) * 4;
        // eslint-disable-next-line security/detect-object-injection -- bounded RGBA index
        out[dIdx] = sourceRgba[sIdx] ?? 0;
        out[dIdx + 1] = sourceRgba[sIdx + 1] ?? 0;
        out[dIdx + 2] = sourceRgba[sIdx + 2] ?? 0;
        out[dIdx + 3] = sourceRgba[sIdx + 3] ?? 255;
      }
    }
  }

  const [dr, dg, db, da] = parseHexToRgba(dividerColor);
  const fillBox = (x0: number, y0: number, w: number, h: number): void => {
    const xEnd = Math.min(canvasWidth, Math.max(0, x0 + w));
    const yEnd = Math.min(canvasHeight, Math.max(0, y0 + h));
    for (let y = Math.max(0, y0); y < yEnd; y += 1) {
      for (let x = Math.max(0, x0); x < xEnd; x += 1) {
        const idx = (y * canvasWidth + x) * 4;
        // eslint-disable-next-line security/detect-object-injection -- bounded RGBA index
        out[idx] = dr;
        out[idx + 1] = dg;
        out[idx + 2] = db;
        out[idx + 3] = da;
      }
    }
  };

  if (cut.layoutType === "SPLIT_2") {
    fillBox(0, Math.floor(canvasHeight / 2) - 1, canvasWidth, 2);
  } else if (cut.layoutType === "TRI_PANEL") {
    const topH = cut.paneAssignments[0]?.canvasPosition.height ?? Math.round(canvasHeight * 0.6);
    const halfW = Math.floor(canvasWidth / 2);
    fillBox(0, topH - 1, canvasWidth, 2);
    fillBox(halfW - 1, topH, 2, canvasHeight - topH);
  } else if (cut.layoutType === "GRID_4") {
    const halfW = Math.floor(canvasWidth / 2);
    const halfH = Math.floor(canvasHeight / 2);
    fillBox(0, halfH - 1, canvasWidth, 2);
    fillBox(halfW - 1, 0, 2, canvasHeight);
  }

  return { data: out, geometries };
}

/**
 * Composite a 16:9 RGBA source buffer into a 1080 × 1920 vertical canvas
 * according to any `LayoutCut` (`SOLO`, `SPLIT_2`, `TRI_PANEL`, `GRID_4`),
 * optionally blending with `previousCut` during a 150ms crossfade transition.
 */
export function compositeDirectorLayoutRgbaFrame(
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  cut: LayoutCut,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
    readonly dividerColor?: string;
    readonly previousCut?: LayoutCut | null;
    readonly crossfadeAlpha?: number;
  } = {},
): {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly geometries: PaneVideoGeometry[];
} {
  const canvasWidth = options.canvasWidth ?? 1080;
  const canvasHeight = options.canvasHeight ?? 1920;
  const activeRendered = renderSingleCutToRgba(
    sourceRgba,
    sourceWidth,
    sourceHeight,
    cut,
    canvasWidth,
    canvasHeight,
    options.dividerColor,
  );

  const alpha = options.crossfadeAlpha ?? 1;
  if (options.previousCut && alpha >= 0 && alpha < 1) {
    const prevRendered = renderSingleCutToRgba(
      sourceRgba,
      sourceWidth,
      sourceHeight,
      options.previousCut,
      canvasWidth,
      canvasHeight,
      options.dividerColor,
    );
    const blended = new Uint8Array(activeRendered.data.length);
    const invA = 1 - alpha;
    for (let i = 0; i < blended.length; i += 4) {
      // eslint-disable-next-line security/detect-object-injection -- bounded RGBA index
      blended[i] = Math.round((prevRendered.data[i] ?? 0) * invA + (activeRendered.data[i] ?? 0) * alpha);
      blended[i + 1] = Math.round(
        (prevRendered.data[i + 1] ?? 0) * invA + (activeRendered.data[i + 1] ?? 0) * alpha,
      );
      blended[i + 2] = Math.round(
        (prevRendered.data[i + 2] ?? 0) * invA + (activeRendered.data[i + 2] ?? 0) * alpha,
      );
      blended[i + 3] = 255;
    }
    return {
      data: blended,
      width: canvasWidth,
      height: canvasHeight,
      geometries: activeRendered.geometries,
    };
  }

  return {
    data: activeRendered.data,
    width: canvasWidth,
    height: canvasHeight,
    geometries: activeRendered.geometries,
  };
}

/**
 * Build the FFmpeg `-filter_complex` expression for a `LayoutCut` (`SOLO`,
 * `SPLIT_2`, `TRI_PANEL`, or `GRID_4`).
 */
export function buildDirectorCutFfmpegFilter(cut: LayoutCut): string {
  const panes = cut.paneAssignments;
  const p0 = panes[0];
  if (p0 === undefined) {
    return "[0:v]scale=1080:1920,setsar=1,format=yuv420p[v]";
  }

  const paneStage = (p: LayoutPaneAssignment, label: string): string =>
    `[0:v]crop=w=${String(p.cropRect.width)}:h=${String(p.cropRect.height)}:x=${String(p.cropRect.x)}:y=${String(p.cropRect.y)},scale=${String(p.canvasPosition.width)}:${String(p.canvasPosition.height)},setsar=1[${label}]`;

  if (cut.layoutType === "SOLO" || panes.length === 1) {
    return `${paneStage(p0, "solo")};[solo]format=yuv420p[v]`;
  }

  if (cut.layoutType === "SPLIT_2" || panes.length === 2) {
    const p1 = panes[1] ?? p0;
    return [
      paneStage(p0, "top"),
      paneStage(p1, "bottom"),
      "[top][bottom]vstack=inputs=2,format=yuv420p[v]",
    ].join(";");
  }

  if (cut.layoutType === "TRI_PANEL" || panes.length === 3) {
    const p1 = panes[1] ?? p0;
    const p2 = panes[2] ?? p1;
    return [
      paneStage(p0, "top"),
      paneStage(p1, "bl"),
      paneStage(p2, "br"),
      "[bl][br]hstack=inputs=2[bottom_row]",
      "[top][bottom_row]vstack=inputs=2,format=yuv420p[v]",
    ].join(";");
  }

  // GRID_4 (2×2 Grid)
  const p1 = panes[1] ?? p0;
  const p2 = panes[2] ?? p0;
  const p3 = panes[3] ?? p1;
  return [
    paneStage(p0, "tl"),
    paneStage(p1, "tr"),
    paneStage(p2, "bl"),
    paneStage(p3, "br"),
    "[tl][tr]hstack=inputs=2[top_row]",
    "[bl][br]hstack=inputs=2[bottom_row]",
    "[top_row][bottom_row]vstack=inputs=2,format=yuv420p[v]",
  ].join(";");
}
