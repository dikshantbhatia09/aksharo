/**
 * Subtitle sidecars: segments → SRT, VTT, TXT and Markdown, on the **output**
 * clock.
 *
 * The remapping is the whole job. A segment's `startMs`/`endMs` are on the
 * source clock — the clock the transcript was written on — and a sidecar sits
 * beside an exported file whose clock has had every accepted cut removed from
 * it. Shipping source times would put every caption progressively later than the
 * picture, by exactly the length of the cuts before it, which is the drift D30
 * exists to prevent.
 *
 * `timemap.mapSegment` does the work and answers three things at once: whether
 * the segment survived at all, which output ranges it occupies, and which of its
 * words landed inside a cut. A segment straddling a splice comes back as two
 * ranges and becomes **two cues** — one on each side — because a single cue
 * spanning the splice would be on screen during footage that no longer contains
 * its words.
 *
 * ASS is not written here: `@montaj/ass-exporter` owns it and lands in A18a.
 */

import type { SubtitleFormat, SubtitleScript } from "@montaj/render-manifest";
import type { TimeQuery } from "@montaj/timemap";

import type { RenderProjection } from "./queues.js";

/** One line of subtitle, on the output clock. */
export interface Cue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Speaker id of the first word, for the formats that show one. */
  readonly speaker?: string;
}

export class SubtitleError extends Error {
  public override readonly name = "SubtitleError";
  constructor(
    readonly code: "render/unsupported-subtitle-format",
    message: string,
  ) {
    super(message);
  }
}

/** Formats this service writes today. `ass` is A18a's, via `@montaj/ass-exporter`. */
export const SUPPORTED_SUBTITLE_FORMATS = ["srt", "vtt", "txt", "md"] as const;

export type SupportedSubtitleFormat = (typeof SUPPORTED_SUBTITLE_FORMATS)[number];

export function isSupportedFormat(format: SubtitleFormat): format is SupportedSubtitleFormat {
  return (SUPPORTED_SUBTITLE_FORMATS as readonly string[]).includes(format);
}

export interface BuildCuesOptions {
  readonly projection: RenderProjection;
  readonly timemap: TimeQuery | null;
  readonly script: SubtitleScript;
  readonly dropFillers?: boolean;
  /** Below this, a cue is unreadable; ranges shorter than it are dropped. */
  readonly minCueMs?: number;
}

/** The shortest cue worth writing: two frames at 30 fps. */
export const MIN_CUE_MS = 66;

/**
 * The text of one segment in one script.
 *
 * `textOverrides` wins, then the word's own `scripts[script]`, then its literal
 * text — the same order `render-core`'s `resolveWords` uses, so a burned-in
 * caption and its sidecar always say the same thing.
 */
export function segmentText(
  projection: RenderProjection,
  segmentIndex: number,
  script: SubtitleScript,
  dropFillers: boolean,
): { text: string; speaker: string | undefined } {
  const segment = projection.segments[segmentIndex];
  if (segment === undefined) return { text: "", speaker: undefined };
  const override = segment.textOverrides?.[script];
  const words = wordsOf(projection, segment.startWordId, segment.endWordId).filter(
    (word) => word.deleted !== true && (!dropFillers || word.filler !== true),
  );
  const speaker = words[0]?.sp;
  if (override !== undefined && override !== "") return { text: override, speaker };
  const text = words
    .map((word) => word.scripts?.[script] ?? word.t)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { text, speaker };
}

function wordsOf(
  projection: RenderProjection,
  startWordId: string,
  endWordId: string,
): RenderProjection["words"] {
  const start = projection.words.findIndex((word) => word.wid === startWordId);
  if (start < 0) return [];
  const end = projection.words.findIndex((word, index) => index >= start && word.wid === endWordId);
  return projection.words.slice(start, end < 0 ? projection.words.length : end + 1);
}

/** Every visible segment as one or more cues on the output clock. */
export function buildCues(options: BuildCuesOptions): Cue[] {
  const { projection, timemap } = options;
  const minCueMs = options.minCueMs ?? MIN_CUE_MS;
  const dropFillers = options.dropFillers ?? false;

  const collected: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];

  for (const [index, segment] of projection.segments.entries()) {
    if (segment.hidden === true) continue;
    const { text, speaker } = segmentText(projection, index, options.script, dropFillers);
    if (text === "") continue;

    const ranges =
      timemap === null
        ? [{ outputStart: segment.startMs, outputEnd: segment.endMs }]
        : timemap
            .mapRange(segment.startMs, segment.endMs)
            .map((range) => ({ outputStart: range.outputStart, outputEnd: range.outputEnd }));

    for (const range of ranges) {
      if (range.outputEnd - range.outputStart < minCueMs) continue;
      collected.push({
        startMs: range.outputStart,
        endMs: range.outputEnd,
        text,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
  }

  collected.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return collected.map((cue, index) => ({ ...cue, index: index + 1 }));
}

/** `HH:MM:SS,mmm` for SRT; `HH:MM:SS.mmm` for VTT. */
export function formatTimestamp(ms: number, separator: "," | "."): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const secs = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`
  );
}

/** SubRip. CRLF line endings, because that is what every player expects. */
export function toSrt(cues: readonly Cue[]): string {
  return (
    cues
      .map(
        (cue) =>
          `${String(cue.index)}\r\n` +
          `${formatTimestamp(cue.startMs, ",")} --> ${formatTimestamp(cue.endMs, ",")}\r\n` +
          `${cue.text}\r\n`,
      )
      .join("\r\n") + (cues.length > 0 ? "" : "")
  );
}

/** WebVTT. LF line endings and the mandatory `WEBVTT` header. */
export function toVtt(cues: readonly Cue[]): string {
  const body = cues
    .map(
      (cue) =>
        `${String(cue.index)}\n` +
        `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n` +
        `${cue.text}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Plain text: the transcript with no timing, one cue per line. */
export function toTxt(cues: readonly Cue[]): string {
  return `${cues.map((cue) => cue.text).join("\n")}\n`;
}

/**
 * Markdown: timestamps as links-free `[HH:MM:SS]` prefixes, speakers as bold
 * runs. Written for a human reading the transcript, not for a player.
 */
export function toMarkdown(cues: readonly Cue[]): string {
  const lines: string[] = ["# Transcript", ""];
  let previousSpeaker: string | undefined;
  for (const cue of cues) {
    if (cue.speaker !== undefined && cue.speaker !== previousSpeaker) {
      lines.push(`**${cue.speaker}**`, "");
      previousSpeaker = cue.speaker;
    }
    lines.push(`\`${formatTimestamp(cue.startMs, ".").slice(0, 8)}\` ${cue.text}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Serialises cues in one of the supported formats. */
export function renderSidecar(format: SubtitleFormat, cues: readonly Cue[]): string {
  switch (format) {
    case "srt":
      return toSrt(cues);
    case "vtt":
      return toVtt(cues);
    case "txt":
      return toTxt(cues);
    case "md":
      return toMarkdown(cues);
    default:
      throw new SubtitleError(
        "render/unsupported-subtitle-format",
        `${format} sidecars are written by @montaj/ass-exporter, which lands in A18a`,
      );
  }
}
