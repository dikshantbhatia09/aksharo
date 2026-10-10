/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Pillar 3 §07: Streamer Gameplay & Facecam Split Remotion Engine
 *
 * Implements the `<StreamerLayout />` (and `<StreamerGameplayLayout />` alias)
 * Remotion layout component, FFmpeg filtergraph synthesizer, and deterministic
 * RGBA buffer compositor:
 * - Top Pane (0 <= y <= 672 px, Top 35%): Streamer webcam overlay scaled with
 *   uniform aspect-fill.
 * - Bottom Pane (672 <= y <= 1920 px, Bottom 65%): Centered action gameplay
 *   footage (1080 x 1248 px).
 * - Separator: 3px neon gamer border (customizable color, default `#8B5CF6` Twitch
 *   purple or `#00FFA3` neon green) with dynamic neon glow effect (`boxShadow`).
 * - Kinetic captions across the boundary with dynamic word highlighting.
 * - Dynamic gamer kill-streak / clutch play overlay cues.
 */

import {
  Fragment,
  OffthreadVideo,
  computePaneVideoLayout,
  h,
  type KineticCaptionWord,
  type PaneVideoGeometry,
  type SplitScreenCrop,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const STREAMER_CANVAS_WIDTH = 1080;
export const STREAMER_CANVAS_HEIGHT = 1920;
export const STREAMER_TOP_PANE_HEIGHT = 672; // 35% of 1920
export const STREAMER_BOTTOM_PANE_HEIGHT = 1248; // 65% of 1920
export const STREAMER_DEFAULT_DIVIDER_COLOR = "#8B5CF6"; // Twitch Purple
export const STREAMER_NEON_GREEN = "#00FFA3";
export const STREAMER_DIVIDER_THICKNESS = 3;

export type StreamerCropRect = SplitScreenCrop;

export interface KillStreakAlertConfig {
  readonly text: string;
  readonly active?: boolean;
  readonly badgeColor?: string;
}

export interface StreamerLayoutConfig {
  /** Crop rectangle of the streamer webcam overlay in source pixels. */
  readonly facecamCrop: StreamerCropRect;
  /** Crop rectangle of the action gameplay in source pixels. */
  readonly gameplayCrop: StreamerCropRect;
  /** Neon separator border color (default: `#8B5CF6` Twitch Purple). */
  readonly dividerColor?: string;
  /** Optional neon glow color for border (defaults to dividerColor). */
  readonly glowColor?: string;
  /** Thickness of the gamer border separator (defaults to 3px). */
  readonly dividerThickness?: number;
  /** Enable dynamic neon glow on divider (defaults to true). */
  readonly showNeonGlow?: boolean;
  /** Optional killstreak / clutch reaction banner cue. */
  readonly killStreakAlert?: KillStreakAlertConfig;
  /** Audio SFX cue identifier for kill-streak or reaction drop. */
  readonly soundCue?: string;
}

export interface StreamerLayoutProps {
  readonly src: string;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly canvasWidth?: number;
  readonly canvasHeight?: number;
  readonly config: StreamerLayoutConfig;
  readonly captionPlacement?: "boundary" | "lower-third";
  readonly captionText?: string;
  readonly captionWords?: readonly KineticCaptionWord[];
  readonly currentTimeSec?: number;
  readonly startFrom?: number;
  readonly endAt?: number;
  readonly muted?: boolean;
  readonly volume?: number;
}

/**
 * Remotion Streamer Layout Component (`<StreamerLayout />`).
 */
export function StreamerLayout(props: StreamerLayoutProps): SplitScreenVNode {
  const canvasWidth = props.canvasWidth ?? STREAMER_CANVAS_WIDTH;
  const canvasHeight = props.canvasHeight ?? STREAMER_CANVAS_HEIGHT;
  const sourceWidth = props.sourceWidth ?? 1920;
  const sourceHeight = props.sourceHeight ?? 1080;
  const topPaneHeight = Math.round(canvasHeight * 0.35); // 672 px
  const bottomPaneHeight = canvasHeight - topPaneHeight; // 1248 px

  const dividerColor = props.config.dividerColor ?? STREAMER_DEFAULT_DIVIDER_COLOR;
  const glowColor = props.config.glowColor ?? dividerColor;
  const dividerThickness = props.config.dividerThickness ?? STREAMER_DIVIDER_THICKNESS;
  const showNeonGlow = props.config.showNeonGlow !== false;
  const captionPlacement = props.captionPlacement ?? "boundary";

  // Top Pane: Streamer Facecam (aspect-fill)
  const topLayout = computePaneVideoLayout(
    props.config.facecamCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: topPaneHeight, top: 0, left: 0 },
  );

  // Bottom Pane: Action Gameplay (aspect-fill centered)
  const bottomLayout = computePaneVideoLayout(
    props.config.gameplayCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: bottomPaneHeight, top: topPaneHeight, left: 0 },
  );

  const activeWords = (props.captionWords ?? []).map((word) => {
    const t = props.currentTimeSec ?? 0;
    const isCurrent = t >= word.startSec && t <= word.endSec;
    return (
      <span
        data-active={isCurrent ? "true" : "false"}
        style={{
          display: "inline-block",
          marginRight: 8,
          color: isCurrent ? (word.highlightColor ?? "#00FFA3") : "#FFFFFF",
          transform: isCurrent ? "scale(1.10)" : "scale(1)",
          fontWeight: 900,
          textShadow: "0 2px 8px rgba(0, 0, 0, 0.85)",
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
    captionPlacement === "boundary"
      ? topPaneHeight
      : Math.round(canvasHeight * 0.84);

  const alert = props.config.killStreakAlert;
  const showAlert = alert !== undefined && (alert.active ?? true);

  return (
    <div
      data-testid="streamer-layout-canvas"
      data-layout="STREAMER_SPLIT"
      style={{
        position: "relative",
        width: canvasWidth,
        height: canvasHeight,
        overflow: "hidden",
        backgroundColor: "#000000",
      }}
    >
      {/* Top 35% Pane: Streamer Facecam */}
      <div
        data-testid="streamer-top-pane"
        data-pane="facecam"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: canvasWidth,
          height: topPaneHeight,
          overflow: "hidden",
          backgroundColor: "#0F0F12",
        }}
      >
        <OffthreadVideo
          data-testid="offthread-video-facecam"
          data-pane="facecam"
          src={props.src}
          startFrom={props.startFrom}
          endAt={props.endAt}
          muted={props.muted ?? false}
          volume={props.volume ?? 1}
          style={{
            position: "absolute",
            width: `${String(topLayout.videoWidth)}px`,
            height: `${String(topLayout.videoHeight)}px`,
            left: `${String(topLayout.videoLeft)}px`,
            top: `${String(topLayout.videoTop)}px`,
            maxWidth: "none",
          }}
        />
      </div>

      {/* 3px Neon Gamer Border Separator with Glow Effect */}
      <div
        data-testid="streamer-divider"
        style={{
          position: "absolute",
          top: topPaneHeight - Math.floor(dividerThickness / 2),
          left: 0,
          width: canvasWidth,
          height: dividerThickness,
          backgroundColor: dividerColor,
          zIndex: 10,
          boxShadow: showNeonGlow
            ? `0 0 14px ${glowColor}, 0 0 4px #FFFFFF`
            : "none",
        }}
      />

      {/* Bottom 65% Pane: Action Gameplay */}
      <div
        data-testid="streamer-bottom-pane"
        data-pane="gameplay"
        style={{
          position: "absolute",
          top: topPaneHeight,
          left: 0,
          width: canvasWidth,
          height: bottomPaneHeight,
          overflow: "hidden",
          backgroundColor: "#000000",
        }}
      >
        <OffthreadVideo
          data-testid="offthread-video-gameplay"
          data-pane="gameplay"
          src={props.src}
          startFrom={props.startFrom}
          endAt={props.endAt}
          muted={props.muted ?? false}
          volume={props.volume ?? 1}
          style={{
            position: "absolute",
            width: `${String(bottomLayout.videoWidth)}px`,
            height: `${String(bottomLayout.videoHeight)}px`,
            left: `${String(bottomLayout.videoLeft)}px`,
            top: `${String(bottomLayout.videoTop)}px`,
            maxWidth: "none",
          }}
        />
      </div>

      {/* Gamer Kill-Streak / Clutch Alert Badge */}
      {showAlert ? (
        <div
          data-testid="gamer-alert-badge"
          style={{
            position: "absolute",
            top: topPaneHeight - 24,
            right: 28,
            padding: "4px 12px",
            borderRadius: 6,
            backgroundColor: alert.badgeColor ?? dividerColor,
            color: "#FFFFFF",
            fontSize: 14,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: 1.2,
            boxShadow: `0 0 12px ${alert.badgeColor ?? dividerColor}`,
            zIndex: 15,
          }}
        >
          {alert.text}
        </div>
      ) : null}

      {/* Kinetic Captions Layer */}
      {hasCaptions ? (
        <div
          data-testid="streamer-captions"
          data-placement={captionPlacement}
          style={{
            position: "absolute",
            top: captionTopPx,
            left: Math.round(canvasWidth / 2),
            transform: "translate(-50%, -50%)",
            maxWidth: Math.round(canvasWidth * 0.90),
            textAlign: "center",
            zIndex: 20,
            pointerEvents: "none",
          }}
        >
          {activeWords.length > 0 ? (
            activeWords
          ) : (
            <span
              style={{
                color: "#FFFFFF",
                fontSize: 28,
                fontWeight: 800,
                textShadow: "0 2px 8px rgba(0, 0, 0, 0.9)",
              }}
            >
              {props.captionText ?? ""}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export const StreamerGameplayLayout = StreamerLayout;

function parseHexColorToRgb(hex: string): readonly [number, number, number] {
  const clean = hex.trim();
  const match = /^#([0-9a-fA-F]{6})$/.exec(clean);
  if (match === null || match[1] === undefined) {
    return [139, 92, 246]; // #8B5CF6
  }
  const intVal = Number.parseInt(match[1], 16);
  return [(intVal >> 16) & 0xff, (intVal >> 8) & 0xff, intVal & 0xff];
}

/**
 * Composite a 16:9 RGBA source buffer into a 1080 × 1920 streamer split layout
 * (Top 35% webcam + Bottom 65% gameplay + 3px neon divider line).
 */
export function compositeStreamerLayoutRgbaFrame(
  sourceRgba: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  config: StreamerLayoutConfig,
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
  const canvasWidth = options.canvasWidth ?? STREAMER_CANVAS_WIDTH;
  const canvasHeight = options.canvasHeight ?? STREAMER_CANVAS_HEIGHT;
  const topPaneHeight = Math.round(canvasHeight * 0.35); // 672 px
  const bottomPaneHeight = canvasHeight - topPaneHeight; // 1248 px
  const out = new Uint8Array(canvasWidth * canvasHeight * 4);

  const topGeometry = computePaneVideoLayout(
    config.facecamCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: topPaneHeight, top: 0, left: 0 },
  );

  const bottomGeometry = computePaneVideoLayout(
    config.gameplayCrop,
    { width: sourceWidth, height: sourceHeight },
    { width: canvasWidth, height: bottomPaneHeight, top: topPaneHeight, left: 0 },
  );

  const blitPane = (
    geom: PaneVideoGeometry,
    destYOffset: number,
    paneHeight: number,
  ): void => {
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
        out[dIdx] = sourceRgba[sIdx] ?? 0;
        out[dIdx + 1] = sourceRgba[sIdx + 1] ?? 0;
        out[dIdx + 2] = sourceRgba[sIdx + 2] ?? 0;
        out[dIdx + 3] = sourceRgba[sIdx + 3] ?? 255;
      }
    }
  };

  blitPane(topGeometry, 0, topPaneHeight);
  blitPane(bottomGeometry, topPaneHeight, bottomPaneHeight);

  // Draw 3px neon gamer border separator across canvas width at topPaneHeight
  const dividerColor = config.dividerColor ?? STREAMER_DEFAULT_DIVIDER_COLOR;
  const [dr, dg, db] = parseHexColorToRgb(dividerColor);
  const thickness = config.dividerThickness ?? STREAMER_DIVIDER_THICKNESS;
  const startY = Math.max(0, topPaneHeight - Math.floor(thickness / 2));

  for (let dy = 0; dy < thickness; dy += 1) {
    const lineY = startY + dy;
    if (lineY >= canvasHeight) break;
    const rowOffset = lineY * canvasWidth * 4;
    for (let px = 0; px < canvasWidth; px += 1) {
      const idx = rowOffset + px * 4;
      out[idx] = dr;
      out[idx + 1] = dg;
      out[idx + 2] = db;
      out[idx + 3] = 255;
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

function isSafeColor(val: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(val) || /^[a-zA-Z]+$/.test(val);
}

/**
 * Build the FFmpeg `-filter_complex` expression for streamer gameplay + facecam layout.
 */
export function buildStreamerLayoutFfmpegFilter(
  config: StreamerLayoutConfig,
  options: {
    readonly canvasWidth?: number;
    readonly canvasHeight?: number;
  } = {},
): string {
  const canvasWidth = options.canvasWidth ?? STREAMER_CANVAS_WIDTH;
  const canvasHeight = options.canvasHeight ?? STREAMER_CANVAS_HEIGHT;
  const topPaneHeight = Math.round(canvasHeight * 0.35); // 672 px
  const bottomPaneHeight = canvasHeight - topPaneHeight; // 1248 px
  const thickness = config.dividerThickness ?? STREAMER_DIVIDER_THICKNESS;
  const divY = Math.max(0, topPaneHeight - Math.floor(thickness / 2));
  const rawColor = config.dividerColor ?? STREAMER_DEFAULT_DIVIDER_COLOR;
  const safeColor = isSafeColor(rawColor) ? rawColor : STREAMER_DEFAULT_DIVIDER_COLOR;

  const { facecamCrop: cam, gameplayCrop: game } = config;

  return [
    `[0:v]crop=w=${String(cam.width)}:h=${String(cam.height)}:x=${String(cam.x)}:y=${String(cam.y)},scale=${String(canvasWidth)}:${String(topPaneHeight)}[facecam]`,
    `[0:v]crop=w=${String(game.width)}:h=${String(game.height)}:x=${String(game.x)}:y=${String(game.y)},scale=${String(canvasWidth)}:${String(bottomPaneHeight)}[gameplay]`,
    `[facecam][gameplay]vstack[stacked]`,
    `[stacked]drawbox=y=${String(divY)}:color=${safeColor}:width=${String(canvasWidth)}:height=${String(thickness)}:t=fill[v]`,
  ].join(";");
}
