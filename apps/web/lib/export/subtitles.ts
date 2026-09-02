/**
 * Subtitle exports (brief §4): SRT/VTT/TXT generated client-side from the
 * projection + timemap. ASS is out for this build — see the note at the
 * bottom of this file — and DOCX/MD go through the cloud endpoint (A21),
 * which this module does not call.
 */

import {
  resolveWords,
  wordsBetween,
  type DisplayScript,
  type EdgProjection,
} from "@montaj/render-core";
import type { TimeMap, WordTimes } from "@montaj/timemap";

export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface BuildCuesOptions {
  readonly projection: EdgProjection;
  /** `null` when the project has no accepted edits: output time is source time. */
  readonly timemap: TimeMap | null;
  readonly script: DisplayScript;
  readonly dropFillers?: boolean;
}

/**
 * One cue per visible, non-hidden segment, in reading (`seq`) order, with
 * every word's text joined by a single space. A segment split across a cut
 * (partially retained) is clipped to its retained ranges' output span; a
 * segment entirely inside a cut is dropped.
 */
export function buildSubtitleCues(options: BuildCuesOptions): SubtitleCue[] {
  const { projection, timemap, script } = options;
  const cues: SubtitleCue[] = [];

  // `visibleSegments` filters on source time; for a whole-track export every
  // segment is "visible" at its own instant, so walk them directly in seq
  // order instead (mirrors how `renderFrame` samples per output ms, but here
  // we want a single cue per segment, not per frame).
  const segments = [...projection.segments]
    .filter((segment) => segment.hidden !== true)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

  for (const segment of segments) {
    const words = wordsBetween(projection.words, segment.startWordId, segment.endWordId);
    const rendered = resolveWords({
      segment,
      words,
      script,
      ...(options.dropFillers === undefined ? {} : { dropFillers: options.dropFillers }),
    });
    if (rendered.length === 0) continue;
    const text = rendered
      .map((word) => word.t)
      .join(" ")
      .trim();
    if (text.length === 0) continue;

    let startMs: number;
    let endMs: number;
    if (timemap === null) {
      startMs = segment.startMs;
      endMs = segment.endMs;
    } else {
      const mapped = timemap.mapSegment(segment, words as unknown as WordTimes[]);
      if (
        mapped.hidden ||
        mapped.visibleRanges.length === 0 ||
        mapped.outputStartMs === null ||
        mapped.outputEndMs === null
      ) {
        continue;
      }
      startMs = mapped.outputStartMs;
      endMs = mapped.outputEndMs;
    }
    if (endMs <= startMs) continue;
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatTimestamp(ms: number, decimalSeparator: "," | "."): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const millis = clamped % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${decimalSeparator}${pad(millis, 3)}`;
}

export function toSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map((cue, index) => {
      const start = formatTimestamp(cue.startMs, ",");
      const end = formatTimestamp(cue.endMs, ",");
      return `${String(index + 1)}\n${start} --> ${end}\n${cue.text}\n`;
    })
    .join("\n");
}

export function toVtt(cues: readonly SubtitleCue[]): string {
  const body = cues
    .map((cue) => {
      const start = formatTimestamp(cue.startMs, ".");
      const end = formatTimestamp(cue.endMs, ".");
      return `${start} --> ${end}\n${cue.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toTxt(cues: readonly SubtitleCue[]): string {
  return cues.map((cue) => cue.text).join("\n") + (cues.length > 0 ? "\n" : "");
}

export type SubtitleClientFormat = "srt" | "vtt" | "txt";

export function renderSubtitleFile(
  cues: readonly SubtitleCue[],
  format: SubtitleClientFormat,
): string {
  switch (format) {
    case "srt":
      return toSrt(cues);
    case "vtt":
      return toVtt(cues);
    case "txt":
      return toTxt(cues);
  }
}

/**
 * ASS export (brief §4: "ASS via `@montaj/ass-exporter` only for
 * `assExportable` styles") is not implemented in this build.
 *
 * `packages/ass-exporter` is still A01's placeholder — `PACKAGE_INFO.implemented`
 * is `false`, `src/index.ts` exports nothing but that flag (checked while
 * reading first per the setup instructions; A18a, which the package README
 * names as the owner, has not landed on `main` as of this branch). There is no
 * ASS writer to call. `assExportableFormats` below always reports `ass` as
 * unavailable so the dialog can grey the option out with an honest reason
 * rather than silently omitting it or throwing at render time; wiring it in is
 * a one-line change once `@montaj/ass-exporter` ships.
 */
export function assExportUnavailableReason(): string {
  return "ASS export ships with @montaj/ass-exporter (A18a), not yet landed on main.";
}
