import type { Segment, TranscriptChunk, Word } from "@montaj/edg/schemas";

/**
 * Transcript exports in **source time** (A11).
 *
 * Source time means the media's own clock: a cue is where the words were spoken
 * in the uploaded file. The moment a project has cuts, that stops being the same
 * as the finished video's clock, and an SRT written against source time will drift
 * against the export. Mapping cues through the cut list is A21's job (`@montaj/timemap`)
 * and it owns the *output-time* variants of these same four formats — this module
 * deliberately does not try, because a silently wrong subtitle file is worse than
 * one the user knows is a transcript.
 *
 * The four formats, and who each is for:
 *
 * | Format | For                                                                     |
 * | ------ | ----------------------------------------------------------------------- |
 * | `json` | Another tool. The manifest plus every chunk, ids and timings intact.     |
 * | `srt`  | YouTube, Premiere, anything that has ever read a subtitle.               |
 * | `vtt`  | The web player, and anything that wants styling later.                   |
 * | `txt`  | A human reading it: speaker-labelled paragraphs, no timings.             |
 *
 * Cues come from the **editing document's segments** where one exists, because
 * those are the captions the user has seen and edited. A project transcribed but
 * never opened has no segments yet, and then the words themselves are grouped by
 * pause — an export must never be empty just because the editor has not run.
 */

export const TRANSCRIPT_EXPORT_FORMATS = ["json", "srt", "vtt", "txt"] as const;
export type TranscriptExportFormat = (typeof TRANSCRIPT_EXPORT_FORMATS)[number];

export function isExportFormat(value: unknown): value is TranscriptExportFormat {
  return (
    typeof value === "string" && (TRANSCRIPT_EXPORT_FORMATS as readonly string[]).includes(value)
  );
}

export const EXPORT_MEDIA_TYPES: Readonly<Record<TranscriptExportFormat, string>> = {
  json: "application/json; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** One caption's worth of text on the source clock. */
export interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
}

export interface ExportInput {
  readonly transcriptId: string;
  readonly revision: number;
  readonly language: string;
  readonly chunks: readonly TranscriptChunk[];
  /** The editing document's captions, in `seq` order. Empty when it has none. */
  readonly segments?: readonly Segment[];
  /** Leave tagged fillers out of the cues, as the captions do. */
  readonly dropFillers?: boolean;
  /**
   * Export a specific script (A22): `roman` | `native` | `en` | `translated`.
   * A segment's own `textOverrides[script]` wins where the user (or a
   * translation job) set one; otherwise every word's `scripts[script]` is used,
   * falling back to the word's primary text `t` when that word carries no
   * variant for this script (an English token inside a transliterated Hinglish
   * segment, say). Omitted keeps the pre-A22 default (`roman` then `native`
   * text-override, then the primary words) so every existing caller is
   * unaffected.
   */
  readonly script?: string;
}

/** One word's text in `script`, falling back to its primary text `t`. */
function wordText(word: Word, script: string | undefined): string {
  if (script === undefined || script === "translated") return word.t;
  const variant = word.scripts?.[script as "roman" | "native" | "en"];
  return variant ?? word.t;
}

/** A live word: not tombstoned, and not a filler when fillers are dropped. */
function isLive(word: Word, dropFillers: boolean): boolean {
  if (word.deleted === true) return false;
  return !(dropFillers && word.filler === true);
}

/** Every live word of the transcript, in document order. */
export function liveWords(input: ExportInput): Word[] {
  const dropFillers = input.dropFillers === true;
  return [...input.chunks]
    .sort((left, right) => left.chunkIdx - right.chunkIdx)
    .flatMap((chunk) => chunk.words.filter((word) => isLive(word, dropFillers)));
}

/**
 * Turn the transcript into cues.
 *
 * With segments, each caption's cue is the words its `startWordId`..`endWordId`
 * range covers, with a `textOverrides` value winning where the user typed one.
 * Without them, the words are grouped on a pause of 700 ms or a 42-character
 * line — a readable paragraph rather than a caption, because a project with no
 * document has no caption limits chosen yet.
 */
export function toCues(input: ExportInput): Cue[] {
  const words = liveWords(input);
  if (words.length === 0) return [];

  const segments = input.segments ?? [];
  if (segments.length === 0) return groupByPause(words, input.script);

  const positions = new Map<string, number>();
  for (const [index, word] of words.entries()) positions.set(word.wid, index);

  const cues: Cue[] = [];
  for (const segment of segments) {
    if (segment.hidden === true) continue;
    const from = positions.get(segment.startWordId);
    const to = positions.get(segment.endWordId);
    if (from === undefined || to === undefined || to < from) continue;

    const run = words.slice(from, to + 1);
    // A specific script asked for that script's own override, and nothing
    // else's — `roman ?? native` is the pre-A22 default kept for callers that
    // pass no script at all.
    const override =
      input.script === undefined
        ? (segment.textOverrides?.["roman"] ?? segment.textOverrides?.["native"])
        : segment.textOverrides?.[input.script];
    const text = override ?? run.map((word) => wordText(word, input.script)).join(" ");
    if (text.trim() === "") continue;

    const speaker = run[0]?.sp;
    cues.push({
      startMs: segment.startMs,
      endMs: Math.max(segment.endMs, segment.startMs + 1),
      text: text.trim(),
      ...(speaker === undefined ? {} : { speaker }),
    });
  }
  return cues;
}

/** One segment's plain source text, for a producer that needs `segmentId` too. */
export interface SegmentSourceText {
  readonly segmentId: string;
  readonly text: string;
}

/**
 * `{segmentId, text}` for every live segment, in the transcript's **primary**
 * script — never a `textOverrides` value, script or otherwise.
 *
 * A22's translation producer uses this to read what a segment currently says
 * before asking a provider to translate it: translating a segment's own
 * `translated` override (a stale earlier translation) or a transliterated
 * variant would compound errors across regenerations instead of always
 * translating from the one text every script is derived from.
 */
export function segmentSourceTexts(input: ExportInput): SegmentSourceText[] {
  const words = liveWords(input);
  if (words.length === 0) return [];
  const segments = input.segments ?? [];
  if (segments.length === 0) return [];

  const positions = new Map<string, number>();
  for (const [index, word] of words.entries()) positions.set(word.wid, index);

  const out: SegmentSourceText[] = [];
  for (const segment of segments) {
    if (segment.hidden === true) continue;
    const from = positions.get(segment.startWordId);
    const to = positions.get(segment.endWordId);
    if (from === undefined || to === undefined || to < from) continue;

    const text = words
      .slice(from, to + 1)
      .map((word) => word.t)
      .join(" ")
      .trim();
    if (text === "") continue;
    out.push({ segmentId: segment.id, text });
  }
  return out;
}

/** Pause and line-length grouping for a transcript with no document yet. */
function groupByPause(words: readonly Word[], script?: string, gapMs = 700, maxChars = 42): Cue[] {
  const cues: Cue[] = [];
  let run: Word[] = [];

  const flush = (): void => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return;
    cues.push({
      startMs: first.s,
      endMs: Math.max(last.e, first.s + 1),
      text: run.map((word) => wordText(word, script)).join(" "),
      ...(first.sp === undefined ? {} : { speaker: first.sp }),
    });
    run = [];
  };

  for (const word of words) {
    const previous = run[run.length - 1];
    const chars = run.reduce((total, entry) => total + wordText(entry, script).length + 1, 0);
    const wordLength = wordText(word, script).length;
    const breaks =
      previous !== undefined &&
      (word.s - previous.e >= gapMs || chars + wordLength > maxChars || word.sp !== previous.sp);
    if (breaks) flush();
    run.push(word);
  }
  flush();
  return cues;
}

/** `HH:MM:SS,mmm` (SubRip) or `HH:MM:SS.mmm` (WebVTT). */
export function timecode(ms: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(millis, 3)}`;
}

/** One cue block, with the blank line every subtitle format separates them by. */
function block(lines: readonly string[]): string {
  return `${lines.join("\n")}\n\n`;
}

/** SubRip: numbered cues, a blank line after every one, the last one included. */
export function toSrt(cues: readonly Cue[]): string {
  return cues
    .map((cue, index) =>
      block([
        String(index + 1),
        `${timecode(cue.startMs, ",")} --> ${timecode(cue.endMs, ",")}`,
        cue.text,
      ]),
    )
    .join("");
}

/** WebVTT: the same cues under the mandatory header, with `.` for the millis. */
export function toVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) =>
      block([`${timecode(cue.startMs, ".")} --> ${timecode(cue.endMs, ".")}`, cue.text]),
    )
    .join("");
  return `WEBVTT\n\n${body}`;
}

/**
 * Plain text: one paragraph per speaker turn, prefixed with the speaker when the
 * transcript was diarised. No timings — this is the format somebody pastes into a
 * blog post or a show-notes document.
 */
export function toTxt(cues: readonly Cue[]): string {
  const paragraphs: string[] = [];
  let speaker: string | undefined;
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.join(" ");
    paragraphs.push(speaker === undefined ? text : `${speaker}: ${text}`);
    current = [];
  };

  for (const cue of cues) {
    if (cue.speaker !== speaker) {
      flush();
      speaker = cue.speaker;
    }
    current.push(cue.text);
  }
  flush();
  return `${paragraphs.join("\n\n")}\n`;
}

/** The machine-readable export: the manifest plus every chunk, ids intact. */
export function toJson(input: ExportInput): string {
  return `${JSON.stringify(
    {
      transcriptId: input.transcriptId,
      revision: input.revision,
      language: input.language,
      timebase: "source",
      chunks: [...input.chunks]
        .sort((left, right) => left.chunkIdx - right.chunkIdx)
        .map((chunk) => ({
          chunkIdx: chunk.chunkIdx,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          words: chunk.words,
        })),
    },
    null,
    2,
  )}\n`;
}

/** Render one transcript in the requested format. */
export function renderExport(format: TranscriptExportFormat, input: ExportInput): string {
  if (format === "json") return toJson(input);
  const cues = toCues(input);
  switch (format) {
    case "srt":
      return toSrt(cues);
    case "vtt":
      return toVtt(cues);
    case "txt":
      return toTxt(cues);
  }
}
