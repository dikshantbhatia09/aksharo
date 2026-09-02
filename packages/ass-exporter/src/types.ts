import type { StyleDoc } from "@montaj/caption-styles";
import type { TimeQuery } from "@montaj/timemap";

export interface AssCanvas {
  readonly width: number;
  readonly height: number;
}

/** The subset of an EDG `Segment` (CONTRACTS §2) the exporter reads. */
export interface AssSegment {
  readonly id: string;
  readonly seq?: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startWordId: string;
  readonly endWordId: string;
  readonly styleRef?: string;
  readonly hidden?: boolean;
  readonly textOverrides?: Readonly<Record<string, string>>;
}

/** The subset of an EDG `Word` the exporter reads. */
export interface AssWord {
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
  readonly sp?: string;
  readonly filler?: boolean;
  readonly deleted?: boolean;
  readonly scripts?: Readonly<Record<string, string>>;
}

/** The read model `toAss` needs: segments in `seq` order, plus the canvas. */
export interface AssProjection {
  readonly canvas: AssCanvas;
  readonly segments: readonly AssSegment[];
}

/** All the transcript's words, in reading order — `toAss`'s `transcript` parameter. */
export type AssTranscript = readonly AssWord[];

/** `styleRef -> StyleDoc`, exactly the shape `resolveStyleSnapshot` already builds. */
export type AssStyleCatalogue = ReadonlyMap<string, StyleDoc> | Readonly<Record<string, StyleDoc>>;

export function styleFromCatalogue(
  catalogue: AssStyleCatalogue,
  styleRef: string | undefined,
  defaultStyleId: string | undefined,
): StyleDoc | undefined {
  const key = styleRef ?? defaultStyleId;
  if (key === undefined) return undefined;
  return catalogue instanceof Map
    ? catalogue.get(key)
    : (catalogue as Readonly<Record<string, StyleDoc>>)[key];
}

export interface ToAssOptions {
  /** Remaps segment/word times onto the output clock (D30); omit for source-clock sidecars. */
  readonly timemap?: TimeQuery | null;
  /** Which of a word's `scripts` to burn in; falls back to `t`. */
  readonly script?: "roman" | "native" | "en";
  readonly dropFillers?: boolean;
  /** `styleRef` used when a segment carries none. */
  readonly defaultStyleId?: string;
  /**
   * Emit one `\pos`-ed event per word instead of one per line. Needed for
   * word-pop and per-word emphasis styles; costs one event per word instead
   * of one per caption.
   */
  readonly perWordPositions?: boolean;
  /** PlayResX/Y override; defaults to `projection.canvas`. */
  readonly canvas?: AssCanvas;
}
