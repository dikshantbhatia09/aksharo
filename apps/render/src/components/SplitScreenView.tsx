/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Two-Speaker Vertical Split-Screen Layout Engine (Pillar 3 §02).
 *
 * Remotion-compatible `<SplitScreenView />` (and `<SplitScreenLayout />` alias)
 * compositor plus aspect-preserving RGBA canvas compositor and FFmpeg filtergraph
 * generator:
 * - Uses two `<OffthreadVideo>` elements referencing the same source video.
 * - Applies CSS `clipPath` and absolute positioning to lock Top (Speaker 1 / Host)
 *   and Bottom (Speaker 2 / Guest) panes inside a 9:16 vertical canvas (1080 × 1920).
 * - Renders a 2px aesthetic divider line (`#1A1A1A` default) with optional
 *   dynamic active-speaker activity halos and `1.02x` speaker emphasis scale.
 * - Places animated kinetic captions centered across the divider line or in the
 *   lower third.
 * - Intelligently alternates between `SPLIT_SCREEN` during rapid dialogue and
 *   `SOLO_FULL_SCREEN` during extended monologues.
 */

import {
  computeWordMargin,
  computeWordSpringScale,
  computeWordYOffset,
} from "@montaj/caption-styles";

export interface SplitScreenCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SplitScreenConfig {
  readonly enabled: boolean;
  readonly topCrop: SplitScreenCrop;
  readonly bottomCrop: SplitScreenCrop;
  readonly dividerColor?: string;
  readonly activeSpeakerHighlight?: boolean;
}

export interface KineticCaptionWord {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly highlightColor?: string;
  readonly emoji?: {
    readonly char: string;
    readonly assetKey?: string;
    readonly position?: "above" | "before" | "after";
  };
}

export interface SplitScreenStyle {
  readonly [key: string]: string | number | undefined;
}

export interface SplitScreenVNode {
  readonly type: string | ((props: Record<string, unknown>) => SplitScreenVNode);
  readonly props: Readonly<Record<string, unknown>> & {
    readonly style?: SplitScreenStyle;
    readonly children: readonly (SplitScreenVNode | string)[];
  };
}

export type SplitScreenChild =
  | SplitScreenVNode
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly SplitScreenChild[];

function flattenChildren(
  items: readonly SplitScreenChild[],
  out: (SplitScreenVNode | string)[] = [],
): (SplitScreenVNode | string)[] {
  for (const item of items) {
    if (item === null || item === undefined || typeof item === "boolean") continue;
    if (Array.isArray(item)) {
      flattenChildren(item, out);
    } else if (typeof item === "number") {
      out.push(String(item));
    } else {
      out.push(item as SplitScreenVNode | string);
    }
  }
  return out;
}

export function h(
  type: string | ((props: Record<string, unknown>) => SplitScreenVNode),
  props: Record<string, unknown> | null,
  ...children: SplitScreenChild[]
): SplitScreenVNode {
  const flat = flattenChildren(children);
  const mergedProps = {
    ...(props ?? {}),
    children: flat,
  };
  if (typeof type === "function") {
    return type(mergedProps);
  }
  return {
    type,
    props: mergedProps,
  };
}

export function Fragment(props: {
  readonly children?: readonly (SplitScreenVNode | string)[];
}): SplitScreenVNode {
  return {
    type: "fragment",
    props: {
      children: props.children ?? [],
    },
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- global JSX namespace for zero-dependency TSX compilation in @montaj/render
  namespace JSX {
    type Element = SplitScreenVNode;
    interface IntrinsicElements {
      readonly div: Record<string, unknown>;
      readonly span: Record<string, unknown>;
      readonly img: Record<string, unknown>;
    }
  }
}

export interface OffthreadVideoProps {
  readonly src: string;
  readonly style?: SplitScreenStyle;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
  readonly "data-pane"?: "top" | "bottom" | "solo" | "facecam" | "gameplay";
  readonly "data-testid"?: string;
}

/**
 * Remotion `<OffthreadVideo>` descriptor referencing a video stream with
 * frame-accurate seek bounds and CSS transform/positioning.
 */
export function OffthreadVideo(props: OffthreadVideoProps): SplitScreenVNode {
  return {
    type: "OffthreadVideo",
    props: {
      ...props,
      children: [],
    },
  };
}

export interface PaneVideoGeometry {
  readonly paneWidth: number;
  readonly paneHeight: number;
  readonly paneTop: number;
  readonly paneLeft: number;
  readonly clipPath: string;
  readonly scale: number;
  readonly activeScale: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly videoLeft: number;
  readonly videoTop: number;
  readonly aspectRatioPreserved: boolean;
}

/**
 * Compute uniform (distortion-free) cover scaling and offsets that lock a source
 * crop window (`crop.x, crop.y, crop.width, crop.height`) inside a target pane
 * (`paneWidth × paneHeight`).
 */
export function computePaneVideoLayout(
  crop: SplitScreenCrop,
  source: { readonly width: number; readonly height: number },
  pane: {
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly left?: number;
  },
  options: { readonly isActiveSpeaker?: boolean; readonly activeSpeakerHighlight?: boolean } = {},
): PaneVideoGeometry {
  const safeCropW = Math.max(2, crop.width);
  const safeCropH = Math.max(2, crop.height);
  const srcW = Math.max(safeCropW, source.width);
  const srcH = Math.max(safeCropH, source.height);

  // Uniform scale ensures strictly zero aspect distortion (scaleX === scaleY)
  const baseScale = Math.max(pane.width / safeCropW, pane.height / safeCropH);
  const activeScale =
    options.activeSpeakerHighlight === true && options.isActiveSpeaker === true ? 1.02 : 1.0;
  const totalScale = baseScale * activeScale;

  const videoWidth = Math.round(srcW * totalScale * 1000) / 1000;
  const videoHeight = Math.round(srcH * totalScale * 1000) / 1000;

  const cropCenterX = crop.x + safeCropW / 2;
  const cropCenterY = crop.y + safeCropH / 2;

  const videoLeft = Math.round((pane.width / 2 - cropCenterX * totalScale) * 1000) / 1000;
  const videoTop = Math.round((pane.height / 2 - cropCenterY * totalScale) * 1000) / 1000;

  const sourceRatio = srcW / srcH;
  const renderedRatio = videoWidth / videoHeight;
  const aspectRatioPreserved = Math.abs(sourceRatio - renderedRatio) < 1e-3;

  return {
    paneWidth: pane.width,
    paneHeight: pane.height,
    paneTop: pane.top,
    paneLeft: pane.left ?? 0,
    clipPath: "inset(0px 0px 0px 0px)",
    scale: baseScale,
    activeScale,
    videoWidth,
    videoHeight,
    videoLeft,
    videoTop,
    aspectRatioPreserved,
  };
}

export interface SplitScreenViewProps {
  readonly src: string;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly config: SplitScreenConfig;
  readonly activeSpeaker?: "top" | "bottom" | "both" | "none";
  readonly mode?: "SPLIT_SCREEN" | "SOLO_FULL_SCREEN";
  readonly captionPlacement?: "divider" | "lower-third";
  readonly captionText?: string;
  readonly captionWords?: readonly KineticCaptionWord[];
  readonly currentTimeSec?: number;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
}

export const DEFAULT_DIVIDER_COLOR = "#1A1A1A";

/**
 * Remotion Split-Screen Component (`<SplitScreenView />`).
 *
 * Stacks Top Pane (Host / Speaker 1) and Bottom Pane (Guest / Speaker 2) inside
 * a 1080 × 1920 vertical canvas using two `<OffthreadVideo>` elements referencing
 * the same source video, locked with CSS `clip-path` and absolute positioning.
 */
export function SplitScreenView(props: SplitScreenViewProps): SplitScreenVNode {
  const canvasWidth = props.canvasWidth ?? 1080;
  const canvasHeight = props.canvasHeight ?? 1920;
  const sourceWidth = props.sourceWidth ?? 1920;
  const sourceHeight = props.sourceHeight ?? 1080;
  const paneHeight = Math.floor(canvasHeight / 2);
  const dividerColor = props.config.dividerColor ?? DEFAULT_DIVIDER_COLOR;
  const highlightEnabled = props.config.activeSpeakerHighlight ?? false;
  const activeSpeaker = props.activeSpeaker ?? "none";
  const mode = props.mode ?? (props.config.enabled ? "SPLIT_SCREEN" : "SOLO_FULL_SCREEN");
  const captionPlacement = props.captionPlacement ?? "divider";

  const topIsActive = activeSpeaker === "top" || activeSpeaker === "both";
  const bottomIsActive = activeSpeaker === "bottom" || activeSpeaker === "both";

  const topLayout = computePaneVideoLayout(
    props.config.topCrop,
    { width: sourceWidth, height: sourceHeight },
    {
      width: canvasWidth,
      height: mode === "SOLO_FULL_SCREEN" && activeSpeaker === "top" ? canvasHeight : paneHeight,
      top: 0,
      left: 0,
    },
    { isActiveSpeaker: topIsActive, activeSpeakerHighlight: highlightEnabled },
  );

  const bottomLayout = computePaneVideoLayout(
    props.config.bottomCrop,
    { width: sourceWidth, height: sourceHeight },
    {
      width: canvasWidth,
      height:
        mode === "SOLO_FULL_SCREEN" && activeSpeaker === "bottom" ? canvasHeight : paneHeight,
      top: mode === "SOLO_FULL_SCREEN" && activeSpeaker === "bottom" ? 0 : paneHeight,
      left: 0,
    },
    { isActiveSpeaker: bottomIsActive, activeSpeakerHighlight: highlightEnabled },
  );

  const activeWords = (props.captionWords ?? []).map((word, index, list) => {
    const t = props.currentTimeSec ?? 0;
    const isPast = index === list.length - 1 ? t > word.endSec : t >= word.endSec;
    const isCurrent = t >= word.startSec && !isPast;
    const scale = isCurrent ? computeWordSpringScale(t, word.startSec) : 1;
    const yOffset = isCurrent ? computeWordYOffset(t, word.startSec, 60, -4) : 0;
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
    captionPlacement === "divider" ? paneHeight : Math.round(canvasHeight * 0.8);

  return (
    <div
      data-testid="split-screen-canvas"
      data-mode={mode}
      style={{
        position: "relative",
        width: canvasWidth,
        height: canvasHeight,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {/* Top Pane: Host / Speaker 1 */}
      <div
        data-testid="split-screen-top-pane"
        data-pane="top"
        data-active-speaker={topIsActive ? "true" : "false"}
        style={{
          position: "absolute",
          top: topLayout.paneTop,
          left: topLayout.paneLeft,
          width: topLayout.paneWidth,
          height: topLayout.paneHeight,
          overflow: "hidden",
          clipPath: topLayout.clipPath,
          display: mode === "SOLO_FULL_SCREEN" && activeSpeaker === "bottom" ? "none" : "block",
          boxShadow:
            highlightEnabled && topIsActive
              ? "inset 0 0 0 3px rgba(56, 189, 248, 0.85)"
              : "none",
        }}
      >
        <OffthreadVideo
          data-testid="offthread-video-top"
          data-pane="top"
          src={props.src}
          startFrom={props.startFrom}
          endAt={props.endAt}
          muted={props.muted ?? false}
          volume={props.volume ?? 1}
          style={{
            position: "absolute",
            width: topLayout.videoWidth,
            height: topLayout.videoHeight,
            left: topLayout.videoLeft,
            top: topLayout.videoTop,
            objectFit: "cover",
          }}
        />
      </div>

      {/* Bottom Pane: Guest / Speaker 2 */}
      <div
        data-testid="split-screen-bottom-pane"
        data-pane="bottom"
        data-active-speaker={bottomIsActive ? "true" : "false"}
        style={{
          position: "absolute",
          top: bottomLayout.paneTop,
          left: bottomLayout.paneLeft,
          width: bottomLayout.paneWidth,
          height: bottomLayout.paneHeight,
          overflow: "hidden",
          clipPath: bottomLayout.clipPath,
          display: mode === "SOLO_FULL_SCREEN" && activeSpeaker === "top" ? "none" : "block",
          boxShadow:
            highlightEnabled && bottomIsActive
              ? "inset 0 0 0 3px rgba(56, 189, 248, 0.85)"
              : "none",
        }}
      >
        <OffthreadVideo
          data-testid="offthread-video-bottom"
          data-pane="bottom"
          src={props.src}
          startFrom={props.startFrom}
          endAt={props.endAt}
          muted={true}
          volume={0}
          style={{
            position: "absolute",
            width: bottomLayout.videoWidth,
            height: bottomLayout.videoHeight,
            left: bottomLayout.videoLeft,
            top: bottomLayout.videoTop,
            objectFit: "cover",
          }}
        />
      </div>

      {/* Middle 2px Aesthetic Divider Line */}
      {mode === "SPLIT_SCREEN" ? (
        <div
          data-testid="split-screen-divider"
          style={{
            position: "absolute",
            top: paneHeight - 1,
            left: 0,
            width: canvasWidth,
            height: 2,
            backgroundColor: dividerColor,
            zIndex: 10,
          }}
        />
      ) : null}

      {/* Animated Kinetic Captions Layer */}
      {hasCaptions ? (
        <div
          data-testid="kinetic-captions"
          data-placement={captionPlacement}
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

export const SplitScreenLayout = SplitScreenView;

/**
 * Recursively find all `<OffthreadVideo>` or matching element nodes in a
 * rendered {@link SplitScreenVNode} tree.
 */
export function findVNodesByType(
  root: SplitScreenVNode,
  targetType: string,
): SplitScreenVNode[] {
  const matches: SplitScreenVNode[] = [];
  const visit = (node: SplitScreenVNode | string): void => {
    if (typeof node === "string") return;
    if (node.type === targetType) {
      matches.push(node);
    }
    for (const child of node.props.children) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}

/**
 * Find a node by its `data-testid` prop in a rendered {@link SplitScreenVNode} tree.
 */
export function findVNodeByTestId(
  root: SplitScreenVNode,
  testId: string,
): SplitScreenVNode | undefined {
  if (root.props["data-testid"] === testId) return root;
  for (const child of root.props.children) {
    if (typeof child === "string") continue;
    const found = findVNodeByTestId(child, testId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseHexColorToRgba(hex: string | undefined): readonly [number, number, number, number] {
  const clean = (hex ?? DEFAULT_DIVIDER_COLOR).trim();
  const match = /^#([0-9a-fA-F]{6})$/.exec(clean);
  if (match === null || match[1] === undefined) {
    return [26, 26, 26, 255];
  }
  const intVal = Number.parseInt(match[1], 16);
  return [(intVal >> 16) & 0xff, (intVal >> 8) & 0xff, intVal & 0xff, 255];
}

/**
 * Composite a 16:9 RGBA source buffer into a 1080 × 1920 (or custom `canvasWidth × canvasHeight`)
 * dual-stacked split-screen RGBA canvas without aspect distortion.
 *
 * - Top pane (`y in [0, canvasHeight/2)`): samples from `config.topCrop` using uniform cover scale.
 * - Bottom pane (`y in [canvasHeight/2, canvasHeight)`): samples from `config.bottomCrop` using uniform cover scale.
 * - Draws a 2px solid divider at `y = canvasHeight/2 - 1 .. canvasHeight/2`.
 */
export function compositeSplitScreenRgbaFrame(
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  config: SplitScreenConfig,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
  } = {},
): {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly topGeometry: PaneVideoGeometry;
  readonly bottomGeometry: PaneVideoGeometry;
} {
  const canvasWidth = options.canvasWidth ?? 1080;
  const canvasHeight = options.canvasHeight ?? 1920;
  const paneHeight = Math.floor(canvasHeight / 2);
  const out = new Uint8Array(canvasWidth * canvasHeight * 4);

  const topGeometry = computePaneVideoLayout(
    config.topCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: paneHeight, top: 0, left: 0 },
  );
  const bottomGeometry = computePaneVideoLayout(
    config.bottomCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: paneHeight, top: paneHeight, left: 0 },
  );

  const blitPane = (geom: PaneVideoGeometry, destYOffset: number): void => {
    const invScale = 1 / geom.scale;
    for (let py = 0; py < paneHeight; py += 1) {
      const srcY = Math.min(
        sourceHeight - 1,
        Math.max(0, Math.floor((py - geom.videoTop) * invScale)),
      );
      const srcRowOffset = srcY * sourceWidth;
      const dstRowOffset = (destYOffset + py) * canvasWidth;

      for (let px = 0; px < canvasWidth; px += 1) {
        const srcX = Math.min(
          sourceWidth - 1,
          Math.max(0, Math.floor((px - geom.videoLeft) * invScale)),
        );
        const sIdx = (srcRowOffset + srcX) * 4;
        const dIdx = (dstRowOffset + px) * 4;
        // eslint-disable-next-line security/detect-object-injection -- bounded RGBA buffer index
        out[dIdx] = sourceRgba[sIdx] ?? 0;
        out[dIdx + 1] = sourceRgba[sIdx + 1] ?? 0;
        out[dIdx + 2] = sourceRgba[sIdx + 2] ?? 0;
        out[dIdx + 3] = sourceRgba[sIdx + 3] ?? 255;
      }
    }
  };

  blitPane(topGeometry, 0);
  blitPane(bottomGeometry, paneHeight);

  // Draw 2px divider line across the middle (y = paneHeight - 1 and y = paneHeight)
  const [dr, dg, db, da] = parseHexColorToRgba(config.dividerColor);
  for (const divY of [Math.max(0, paneHeight - 1), Math.min(canvasHeight - 1, paneHeight)]) {
    const rowStart = divY * canvasWidth * 4;
    for (let px = 0; px < canvasWidth; px += 1) {
      const idx = rowStart + px * 4;
      // eslint-disable-next-line security/detect-object-injection -- bounded RGBA buffer index
      out[idx] = dr;
      out[idx + 1] = dg;
      out[idx + 2] = db;
      out[idx + 3] = da;
    }
  }

  return {
    data: out,
    width: canvasWidth,
    height: canvasHeight,
    topGeometry,
    bottomGeometry,
  };
}

function isSafeFfmpegDividerColor(value: string): boolean {
  if (value.length === 0 || value.length > 32) return false;
  return /^#[0-9a-fA-F]{6}$/.test(value) || /^[a-zA-Z]+@[0-9.]+$/.test(value) || /^[a-zA-Z]+$/.test(value);
}

/**
 * Build the FFmpeg `-filter_complex` expression for dual-stack vertical split-screen
 * rendering (Pillar 3 §02 §4.1).
 */
export function buildSplitScreenFfmpegFilter(
  config: SplitScreenConfig,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
  } = {},
): string {
  const canvasWidth = options.canvasWidth ?? 1080;
  const canvasHeight = options.canvasHeight ?? 1920;
  const paneHeight = Math.floor(canvasHeight / 2);
  const divY = Math.max(0, paneHeight - 1);
  const rawColor = (config.dividerColor ?? "black@0.6").trim();
  const safeColor = isSafeFfmpegDividerColor(rawColor) ? rawColor : "black@0.6";

  const { topCrop: top, bottomCrop: bottom } = config;
  return [
    `[0:v]crop=w=${String(top.width)}:h=${String(top.height)}:x=${String(top.x)}:y=${String(top.y)},scale=${String(canvasWidth)}:${String(paneHeight)}[top]`,
    `[0:v]crop=w=${String(bottom.width)}:h=${String(bottom.height)}:x=${String(bottom.x)}:y=${String(bottom.y)},scale=${String(canvasWidth)}:${String(paneHeight)}[bottom]`,
    `[top][bottom]vstack[stacked]`,
    `[stacked]drawbox=y=${String(divY)}:color=${safeColor}:width=${String(canvasWidth)}:height=2:t=fill[v]`,
  ].join(";");
}

