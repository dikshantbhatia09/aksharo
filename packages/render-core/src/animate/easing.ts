/**
 * Easing curves.
 *
 * Every animation in `render-core` is a pure function of `tMs`, so a frame can
 * be recomputed from nothing — that is what makes the cloud renderer and the
 * browser agree, and what lets a scrub land on exactly the frame an export
 * produces. No easing here reads a clock, a random source or previous state.
 */

import { clamp01 } from "../units.js";

export type Easing = (t: number) => number;

export const linear: Easing = (t) => clamp01(t);

export const easeOutQuad: Easing = (t) => {
  const k = clamp01(t);
  return 1 - (1 - k) * (1 - k);
};

export const easeOutCubic: Easing = (t) => {
  const k = clamp01(t);
  return 1 - (1 - k) ** 3;
};

export const easeInCubic: Easing = (t) => clamp01(t) ** 3;

export const easeInOutCubic: Easing = (t) => {
  const k = clamp01(t);
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
};

/** Overshoots past 1 and settles: the "pop" of a punch style. */
export const easeOutBack: Easing = (t) => {
  const k = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
};

/** Three decreasing bounces, the classic Penner curve. */
export const easeOutBounce: Easing = (t) => {
  let k = clamp01(t);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (k < 1 / d1) return n1 * k * k;
  if (k < 2 / d1) {
    k -= 1.5 / d1;
    return n1 * k * k + 0.75;
  }
  if (k < 2.5 / d1) {
    k -= 2.25 / d1;
    return n1 * k * k + 0.9375;
  }
  k -= 2.625 / d1;
  return n1 * k * k + 0.984375;
};

export const EASINGS = {
  linear,
  easeOutQuad,
  easeOutCubic,
  easeInCubic,
  easeInOutCubic,
  easeOutBack,
  easeOutBounce,
} as const;

export type EasingName = keyof typeof EASINGS;

/** Linear progress through `[startMs, startMs + durationMs)`, clamped to 0…1. */
export function progress(tMs: number, startMs: number, durationMs: number): number {
  if (durationMs <= 0) return tMs >= startMs ? 1 : 0;
  return clamp01((tMs - startMs) / durationMs);
}

/** `from` → `to` at `t`, with no clamping of the output (so `easeOutBack` can overshoot). */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * A deterministic, seeded shake offset for the `shake` emphasis effect. Two
 * incommensurable sine waves give a jitter that never repeats inside a caption
 * but is identical on every machine, every time.
 */
export function shakeOffset(tMs: number, amplitude: number, seed: number): { x: number; y: number } {
  const phase = tMs / 1000 + seed * 0.37;
  return {
    x: Math.sin(phase * 47.1) * amplitude,
    y: Math.cos(phase * 61.7) * amplitude * 0.6,
  };
}
