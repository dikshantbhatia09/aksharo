/** @jsx h */
/** @jsxFrag Fragment */
/**
 * Remotion Audio Sequencer & Semantic Contextual SFX Mixer (Pillar 5 §06).
 *
 * Implements Submagic-grade micro-sound effects sequencing:
 * - Frame-accurate audio cue anchoring aligned down to exact frame (<= 16.6 ms at 60 fps)
 * - Calibrated non-intrusive mixing level (-18 dBFS default / 0.4 Remotion volume)
 * - Closed-form trapezoid speech ducking integration (-12 dB / 150 ms ramp)
 * - Interactive SFX editor state model allowing creators to preview, change, or mute individual effects
 * - Remotion <Sequence /> and <Audio /> layout tree generator
 */

import {
  Fragment as _Fragment,
  h as _h,
  type SplitScreenStyle,
  type SplitScreenVNode,
} from "./SplitScreenView.js";

export const h = _h;
export const Fragment = _Fragment;

export type SfxCategory = "whoosh" | "pop" | "ding" | "cash" | "impact";

export interface SfxDuckSpec {
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
}

export interface RemotionSfxCue {
  readonly id: string;
  readonly assetId: string;
  readonly startMs: number;
  readonly endMs?: number;
  readonly src: string;
  readonly category?: SfxCategory;
  readonly cueReason?: string;
  readonly gainDb?: number;
  readonly volume?: number;
  readonly isMuted?: boolean;
  readonly duck?: SfxDuckSpec | null;
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
}

export interface AudioMixerProps {
  readonly sfxTracks: readonly RemotionSfxCue[];
  readonly currentTimeSec: number;
  readonly fps?: number;
  readonly durationSec?: number;
  readonly masterVolume?: number;
  readonly muteAll?: boolean;
  readonly speechRanges?: readonly { readonly startMs: number; readonly endMs: number }[];
  readonly style?: SplitScreenStyle;
  readonly "data-testid"?: string;
}

export interface FrameAnchoredCue {
  readonly cue: RemotionSfxCue;
  readonly fromFrame: number;
  readonly durationInFrames: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly effectiveVolume: number;
  readonly isCurrent: boolean;
}

/** Calibrated non-intrusive default gain (-18 dBFS). */
export const DEFAULT_SFX_GAIN_DB = -18.0;

/** Default Remotion slider volume matching -18 dBFS calibration. */
export const DEFAULT_REMOTION_SFX_VOLUME = 0.4;

/** Frame sync threshold SLA (16.6ms = 1 frame at 60 fps). */
export const MAX_SYNC_ACCURACY_MS = 16.6;

/** Minimum spacing SLA in ms (2.5s) between SFX triggers. */
export const MIN_SFX_SPACING_MS = 2500;

/** Converts dB to linear amplitude (10^(dB/20)). */
export function dbToLinearGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Converts seconds to frame index at specified fps. */
export function timeSecToFrame(sec: number, fps = 60): number {
  return Math.round(sec * fps);
}

/** Converts frame index to time in seconds at specified fps. */
export function frameToTimeSec(frame: number, fps = 60): number {
  return frame / fps;
}

/**
 * Calculates ducking gain multiplier at a specific timestamp across speech ranges.
 * Uses -12 dB depth with 150 ms linear attack and release ramps.
 */
export function computeSfxDuckMultiplier(
  timeMs: number,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  duckSpec: SfxDuckSpec = { depthDb: -12, attackMs: 150, releaseMs: 150 },
): number {
  if (speechRanges.length === 0) return 1.0;
  const duckedGain = dbToLinearGain(duckSpec.depthDb);
  let minGain = 1.0;

  for (const range of speechRanges) {
    const outerStart = range.startMs - duckSpec.attackMs;
    const outerEnd = range.endMs + duckSpec.releaseMs;

    if (timeMs >= outerStart && timeMs <= outerEnd) {
      const distanceIn = Math.min(timeMs - outerStart, outerEnd - timeMs);
      const rampSpan = 2 * Math.min(duckSpec.attackMs, duckSpec.releaseMs);
      const depthFactor = Math.min(1.0, distanceIn / Math.max(1, rampSpan));
      const rangeGain = 1.0 + depthFactor * (duckedGain - 1.0);
      minGain = Math.min(minGain, rangeGain);
    }
  }

  return minGain;
}

/**
 * Anchors an SFX cue to exact Remotion timeline frames with millisecond precision (<= 16.6ms SLA).
 */
export function anchorCueToFrames(
  cue: RemotionSfxCue,
  fps = 60,
  defaultDurationMs = 600,
  currentTimeSec = 0,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[] = [],
): FrameAnchoredCue {
  const startSec = cue.startMs / 1000;
  const durationMs = (cue.endMs ?? cue.startMs + defaultDurationMs) - cue.startMs;
  const durationSec = Math.max(0.05, durationMs / 1000);
  const endSec = startSec + durationSec;

  const fromFrame = timeSecToFrame(startSec, fps);
  const durationInFrames = Math.max(1, Math.round(durationSec * fps));

  const baseVolume = cue.volume ?? (cue.gainDb !== undefined ? dbToLinearGain(cue.gainDb) : DEFAULT_REMOTION_SFX_VOLUME);
  const currentTimeMs = currentTimeSec * 1000;
  const duckMultiplier = cue.duck ? computeSfxDuckMultiplier(currentTimeMs, speechRanges, cue.duck) : 1.0;

  const effectiveVolume = cue.isMuted ? 0 : Math.max(0, Math.min(1.0, baseVolume * duckMultiplier));
  const isCurrent = currentTimeSec >= startSec && currentTimeSec < endSec;

  return {
    cue,
    fromFrame,
    durationInFrames,
    startSec,
    endSec,
    effectiveVolume,
    isCurrent,
  };
}

/**
 * Validates whether an SFX cue is synchronous with a visual event within SLA (<= 16.6 ms).
 */
export function isVisualToAuditorySyncAccurate(
  visualEventTimeMs: number,
  cueStartMs: number,
  toleranceMs = MAX_SYNC_ACCURACY_MS,
): boolean {
  return Math.abs(visualEventTimeMs - cueStartMs) <= toleranceMs;
}

/**
 * Manages interactive SFX editor operations (preview, swap, mute, gain adjustment).
 */
export class SfxEditorState {
  private cues: RemotionSfxCue[];

  constructor(initialCues: readonly RemotionSfxCue[] = []) {
    this.cues = [...initialCues];
  }

  getCues(): readonly RemotionSfxCue[] {
    return [...this.cues];
  }

  getCue(id: string): RemotionSfxCue | undefined {
    return this.cues.find((c) => c.id === id);
  }

  addCue(cue: RemotionSfxCue): void {
    this.cues.push(cue);
    this.cues.sort((a, b) => a.startMs - b.startMs);
  }

  removeCue(id: string): boolean {
    const lenBefore = this.cues.length;
    this.cues = this.cues.filter((c) => c.id !== id);
    return this.cues.length < lenBefore;
  }

  swapCueAsset(id: string, newAssetId: string, newSrc: string, newCategory?: SfxCategory): boolean {
    const index = this.cues.findIndex((c) => c.id === id);
    if (index === -1) return false;
    const existing = this.cues[index]!;
    this.cues[index] = {
      ...existing,
      assetId: newAssetId,
      src: newSrc,
      category: newCategory ?? existing.category,
    };
    return true;
  }

  toggleMuteCue(id: string, isMuted?: boolean): boolean {
    const index = this.cues.findIndex((c) => c.id === id);
    if (index === -1) return false;
    const existing = this.cues[index]!;
    this.cues[index] = {
      ...existing,
      isMuted: isMuted ?? !existing.isMuted,
    };
    return true;
  }

  setCueVolume(id: string, volume: number): boolean {
    const index = this.cues.findIndex((c) => c.id === id);
    if (index === -1) return false;
    const existing = this.cues[index]!;
    this.cues[index] = {
      ...existing,
      volume: Math.max(0, Math.min(1.0, volume)),
    };
    return true;
  }
}

export interface RemotionAudioProps {
  readonly src: string;
  readonly startFrom?: number;
  readonly volume?: number;
  readonly "data-ducked"?: string;
  readonly style?: SplitScreenStyle;
}

export function Audio(props: RemotionAudioProps): SplitScreenVNode {
  return (
    <div
      data-remotion-audio="true"
      data-src={props.src}
      data-start-from={String(props.startFrom ?? 0)}
      data-volume={props.volume !== undefined ? String(props.volume) : "1"}
      data-ducked={props["data-ducked"] ?? "false"}
      style={{ display: "none", ...props.style }}
    />
  );
}

/**
 * `<AudioMixer />` Remotion Composition Component.
 *
 * Sequenced Remotion Audio mixer rendering exact frame-anchored <Audio /> and
 * <Sequence /> track representations for preview and final render.
 */
export function AudioMixer(props: AudioMixerProps): SplitScreenVNode {
  const {
    sfxTracks,
    currentTimeSec,
    fps = 60,
    masterVolume = 1.0,
    muteAll = false,
    speechRanges = [],
    style = {},
  } = props;

  const anchoredCues = sfxTracks.map((cue) =>
    anchorCueToFrames(cue, fps, 600, currentTimeSec, speechRanges),
  );

  return (
    <div
      data-testid={props["data-testid"] ?? "remotion-audio-mixer"}
      data-fps={String(fps)}
      data-current-time={currentTimeSec.toFixed(3)}
      data-active-cues={String(anchoredCues.filter((c) => c.isCurrent).length)}
      data-total-cues={String(anchoredCues.length)}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        visibility: "hidden",
        ...style,
      }}
    >
      {anchoredCues.map((anchored) => {
        const finalVolume = muteAll ? 0 : anchored.effectiveVolume * masterVolume;
        return (
          <div
            key={anchored.cue.id}
            data-testid={`sfx-sequence-${anchored.cue.id}`}
            data-cue-id={anchored.cue.id}
            data-asset-id={anchored.cue.assetId}
            data-from-frame={String(anchored.fromFrame)}
            data-duration-frames={String(anchored.durationInFrames)}
            data-volume={finalVolume.toFixed(3)}
            data-is-current={anchored.isCurrent ? "true" : "false"}
            data-category={anchored.cue.category ?? "whoosh"}
          >
            <Audio
              src={anchored.cue.src}
              startFrom={0}
              volume={Number(finalVolume.toFixed(3))}
              data-ducked={anchored.cue.duck ? "true" : "false"}
            />
          </div>
        );
      })}
    </div>
  );
}
