/**
 * MOGRT captions (C06 brief §Scope 2): one Aksharo caption `.mogrt` instance per visible
 * segment on a dedicated video track, with per-segment params resolved by `displayName` with an
 * index fallback (appendix param table — `MOGRT_PARAM_ORDER` in `./types.ts`), and a start-up
 * self-test that inserts one instance in a scratch bin, reads its params back and confirms the
 * mapping before any real apply runs.
 *
 * "Resolved by displayName with index fallback" means: `PremiereHost#setMogrtParams`/
 * `getMogrtParams` take a plain `Record<string, value>` keyed however the *real* MOGRT exposes
 * its component params (Gate C: unverified whether that's the param's `displayName` string or
 * its declared index — see `docs/GATE-C-CHECKLIST.md`). This module never assumes which; it
 * always builds the params object keyed by `MOGRT_PARAM_ORDER`'s names (the shared appendix
 * order with C08b's Text+ macro) and separately exposes `paramsByIndex` for a host adapter that
 * turns out to need index-addressed params, so neither this module nor the host adapter has to
 * guess ahead of the other.
 */
import { MOGRT_PARAM_ORDER } from "./types.js";

import type { MogrtCaptionParams } from "./types.js";
import type { MogrtInsertRequest, MogrtParams, PremiereHost } from "../host/premiere.js";

export interface MogrtCaptionPlacement {
  readonly mogrtPath: string;
  readonly trackIndex: number;
  readonly startFrames: number;
  readonly durationFrames: number;
  readonly params: MogrtCaptionParams;
}

/** Builds the by-name params object in the appendix's fixed order (stable key order helps a
 * future index-fallback adapter zip names 1:1 against a positionally declared param list). */
export function resolveMogrtParams(params: MogrtCaptionParams): MogrtParams {
  const resolved: Record<string, string | number> = {};
  for (const name of MOGRT_PARAM_ORDER) {
    const value = params[name];
    if (value !== undefined) resolved[name] = value;
  }
  return resolved;
}

/** `MOGRT_PARAM_ORDER`, 0-based — the index fallback for a host adapter that must address a
 * MOGRT's component params positionally rather than by `displayName`. */
export function paramsByIndex(params: MogrtCaptionParams): (string | number | undefined)[] {
  return MOGRT_PARAM_ORDER.map((name) => params[name]);
}

export interface InsertCaptionMogrtsInput {
  readonly mogrtPath: string;
  readonly trackIndex: number;
  readonly segments: readonly {
    readonly startFrames: number;
    readonly endFrames: number;
    readonly params: MogrtCaptionParams;
  }[];
}

export interface InsertedCaption {
  readonly itemId: string;
  readonly startFrames: number;
  readonly durationFrames: number;
}

export async function insertCaptionMogrts(
  host: PremiereHost,
  input: InsertCaptionMogrtsInput,
): Promise<InsertedCaption[]> {
  const results: InsertedCaption[] = [];
  for (const segment of input.segments) {
    const request: MogrtInsertRequest = {
      mogrtPath: input.mogrtPath,
      trackIndex: input.trackIndex,
      startFrames: segment.startFrames,
      durationFrames: segment.endFrames - segment.startFrames,
    };
    const { itemId } = await host.insertMogrt(request);
    await host.setMogrtParams(itemId, resolveMogrtParams(segment.params));
    results.push({
      itemId,
      startFrames: segment.startFrames,
      durationFrames: request.durationFrames,
    });
  }
  return results;
}

export interface WordHighlightWindow {
  readonly wid: string;
  /** Relative to the segment's own start, matching `HighlightStart`/`HighlightEnd`'s frame of
   * reference (the MOGRT instance's own in-point, not the sequence timeline). */
  readonly highlightStartFrames: number;
  readonly highlightEndFrames: number;
}

/**
 * Per-word highlight windows (brief §Scope 2: "per-word highlight through the macro's
 * HighlightStart/End keyframes"). `setMogrtParams` in this WP sets one static value per param
 * per instance — it has no time dimension of its own, so animating `HighlightStart`/
 * `HighlightEnd` per word inside a single MOGRT instance (rather than swapping the whole params
 * object once per word) needs Premiere's own component-keyframe API on the MOGRT's Graphic
 * component, which is unverified until Gate C (see docs/GATE-C-CHECKLIST.md, "MOGRT keyframed
 * highlight"). This function only computes the per-word windows in the instance's own frame of
 * reference; wiring them onto real keyframes is the Gate-C follow-up.
 */
export function computeWordHighlightWindows(
  segmentStartFrames: number,
  words: readonly {
    readonly wid: string;
    readonly startFrames: number;
    readonly endFrames: number;
  }[],
): WordHighlightWindow[] {
  return words.map((word) => ({
    wid: word.wid,
    highlightStartFrames: word.startFrames - segmentStartFrames,
    highlightEndFrames: word.endFrames - segmentStartFrames,
  }));
}

export interface MogrtSelfTestResult {
  readonly ok: boolean;
  readonly message?: string;
}

/**
 * Start-up self-test (brief §Scope 2): inserts one scratch instance, reads its params back and
 * refuses with a clear message if the mapping does not round-trip. Callers should run this once
 * per panel session before offering the "MOGRT captions" apply mode, and surface a disabled
 * checkbox with `message` when it fails (see `src/ui/ApplyPanel.tsx`).
 */
export async function runMogrtSelfTest(
  host: PremiereHost,
  mogrtPath: string,
): Promise<MogrtSelfTestResult> {
  const probeParams: MogrtCaptionParams = {
    Text: "Aksharo self-test",
    Size: 1,
    StyleId: "aksharo-self-test",
  };
  try {
    const { itemId } = await host.insertMogrt({
      mogrtPath,
      trackIndex: 0,
      startFrames: 0,
      durationFrames: 1,
    });
    await host.setMogrtParams(itemId, resolveMogrtParams(probeParams));
    const readBack = await host.getMogrtParams(itemId);
    await host.removeItem(itemId);
    if (
      !readBack ||
      readBack.Text !== probeParams.Text ||
      readBack.StyleId !== probeParams.StyleId
    ) {
      return {
        ok: false,
        message:
          "MOGRT self-test failed: params written to the scratch instance did not read back " +
          "unchanged. Captions cannot be inserted until the .mogrt's param names match the " +
          "appendix table.",
      };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `MOGRT self-test failed: ${message}` };
  }
}
