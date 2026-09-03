/**
 * SRT / VTT / ASS / plain-text parsers, normalised onto one cue list.
 *
 * The output is deliberately *not* an EDG document: `POST /projects/{id}/import`
 * stores this list as a sidecar and enqueues `ai.align`, and A11 is what turns
 * aligned words into segments. Keeping the parser's job to "read the file
 * faithfully" is what lets it be a pure function with no database and no clock.
 *
 * Three details are load-bearing rather than defensive:
 *
 * * **The byte-order mark is stripped.** Windows tools write UTF-8 with a BOM
 *   more often than not, and a BOM in front of `WEBVTT` or of `1` makes the first
 *   cue of an otherwise perfect file vanish.
 * * **Line endings are normalised first.** A CRLF file split on `\n\n` never
 *   finds a blank line, because every "blank" line still holds a `\r`.
 * * **Nothing is transliterated or case-folded.** Devanagari, Tamil and mixed
 *   Roman/native text pass through byte for byte; the only text the parsers touch
 *   is ASS override syntax, which is markup rather than content.
 */

export const SUBTITLE_KINDS = ["srt", "vtt", "ass", "txt"] as const;

export type SubtitleKind = (typeof SUBTITLE_KINDS)[number];

/** One normalised cue. `startMs`/`endMs` are absolute media time (CONTRACTS §0). */
export interface SubtitleCue {
  /** Position in the file, from 1. Not the source file's own numbering. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Cue text with the source format's markup removed; may contain newlines. */
  readonly text: string;
  /** ASS `Name` / VTT voice span, when the file carries one. */
  readonly speaker?: string;
}

export interface ParsedSubtitles {
  readonly kind: SubtitleKind;
  readonly cues: readonly SubtitleCue[];
  /** False for `txt`, where the file carries no timings at all. */
  readonly timed: boolean;
  /** Non-fatal problems: a malformed block, a cue that ends before it starts. */
  readonly warnings: readonly string[];
}

/** Raised when the content cannot be read as the kind the caller declared. */
export class SubtitleParseError extends Error {
  constructor(
    readonly kind: SubtitleKind,
    message: string,
  ) {
    super(message);
    this.name = "SubtitleParseError";
  }
}

export function isSubtitleKind(value: unknown): value is SubtitleKind {
  return typeof value === "string" && (SUBTITLE_KINDS as readonly string[]).includes(value);
}

/** Strip a UTF-8 BOM and normalise CRLF / CR to LF. */
export function normaliseText(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, `MM:SS.mmm` or ASS `H:MM:SS.cc` to milliseconds. */
export function parseTimestamp(value: string): number | null {
  const trimmed = value.trim();
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(trimmed);
  if (match === null) return null;

  const hours = Number(match[1] ?? "0");
  const minutes = Number(match[2] ?? "0");
  const seconds = Number(match[3] ?? "0");
  const fraction = match[4] ?? "";
  // ASS writes centiseconds ("0:00:01.50"), SRT and VTT milliseconds. The digit
  // count is what distinguishes them, so it is padded rather than assumed.
  const millis = fraction === "" ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Parse `content` as `kind`. @throws SubtitleParseError when nothing usable is in it. */
export function parseSubtitles(kind: SubtitleKind, content: string): ParsedSubtitles {
  const text = normaliseText(content);
  switch (kind) {
    case "srt":
      return parseSrt(text);
    case "vtt":
      return parseVtt(text);
    case "ass":
      return parseAss(text);
    case "txt":
      return parseTxt(text);
  }
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

const SRT_ARROW = /^(.+?)\s*-->\s*(.+?)\s*$/;

function parseSrt(text: string): ParsedSubtitles {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];

  for (const block of splitBlocks(text)) {
    const lines = block.split("\n");
    // The numbering line is optional in the wild, so the timing line is found
    // rather than assumed to be second.
    const arrowAt = lines.findIndex((line) => SRT_ARROW.test(line));
    if (arrowAt === -1) {
      warnings.push(`block ${String(cues.length + 1)} has no timing line`);
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const timing = SRT_ARROW.exec(lines[arrowAt] ?? "");
    const startMs = parseTimestamp(timing?.[1] ?? "");
    const endMs = parseTimestamp(timing?.[2] ?? "");
    if (startMs === null || endMs === null) {
      warnings.push(`block ${String(cues.length + 1)} has an unreadable timestamp`);
      continue;
    }

    const body = lines
      .slice(arrowAt + 1)
      .join("\n")
      .trim();
    if (body === "") continue;
    cues.push(makeCue(cues.length + 1, startMs, endMs, stripHtml(body), warnings));
  }

  if (cues.length === 0) throw new SubtitleParseError("srt", "no readable cues");
  return { kind: "srt", cues, timed: true, warnings };
}

// ---------------------------------------------------------------------------
// WebVTT
// ---------------------------------------------------------------------------

function parseVtt(text: string): ParsedSubtitles {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];

  const body = text.startsWith("WEBVTT") ? text.slice(text.indexOf("\n") + 1) : text;
  if (!text.startsWith("WEBVTT")) warnings.push("missing the WEBVTT header");

  for (const block of splitBlocks(body)) {
    const first = block.split("\n")[0] ?? "";
    // NOTE, STYLE and REGION blocks are metadata, not cues.
    if (/^(NOTE|STYLE|REGION)\b/.test(first)) continue;

    const lines = block.split("\n");
    const arrowAt = lines.findIndex((line) => line.includes("-->"));
    if (arrowAt === -1) {
      warnings.push(`block starting ${JSON.stringify(first.slice(0, 24))} has no timing line`);
      continue;
    }

    // A VTT timing line may carry cue settings after the end timestamp
    // ("align:middle line:90%"), which are positioning and not our business.
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const [rawStart = "", rest = ""] = (lines[arrowAt] ?? "").split("-->");
    const rawEnd = rest.trim().split(/\s+/)[0] ?? "";
    const startMs = parseTimestamp(rawStart);
    const endMs = parseTimestamp(rawEnd);
    if (startMs === null || endMs === null) {
      warnings.push(`cue ${String(cues.length + 1)} has an unreadable timestamp`);
      continue;
    }

    const raw = lines
      .slice(arrowAt + 1)
      .join("\n")
      .trim();
    if (raw === "") continue;

    // `[^\s>.]` (not `[^\s>]`) in the repeated `.class` segment: excluding `.`
    // from the segment's own character class keeps each dot the unambiguous
    // start of a new segment, so the engine can't backtrack over exponentially
    // many ways to split a long dotted run — `raw` is attacker-controlled
    // (user-uploaded subtitle files), and the previous, overlapping character
    // class was a ReDoS candidate (security/detect-unsafe-regex).
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded or disjoint-alternation pattern, reviewed and timed against adversarial input -- not exponential; see the WP report
    const voice = /^<v(?:\.[^\s>.]+)*\s+([^>]+)>/.exec(raw);
    const speaker = voice?.[1]?.trim();
    const cleaned = stripHtml(raw);
    cues.push(makeCue(cues.length + 1, startMs, endMs, cleaned, warnings, speaker));
  }

  if (cues.length === 0) throw new SubtitleParseError("vtt", "no readable cues");
  return { kind: "vtt", cues, timed: true, warnings };
}

// ---------------------------------------------------------------------------
// Advanced SubStation Alpha
// ---------------------------------------------------------------------------

function parseAss(text: string): ParsedSubtitles {
  const warnings: string[] = [];
  const cues: SubtitleCue[] = [];

  const lines = text.split("\n");
  let inEvents = false;
  /** Column order from the `Format:` line; ASS files are free to reorder it. */
  let format: string[] = [
    "Layer",
    "Start",
    "End",
    "Style",
    "Name",
    "MarginL",
    "MarginR",
    "MarginV",
    "Effect",
    "Text",
  ];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((column) => column.trim());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;

    // Every field but the last is comma-free; `Text` may contain commas, so the
    // split is bounded by the format's column count.
    const values = splitLimited(line.slice(line.indexOf(":") + 1), ",", format.length);
    const field = (name: string): string => {
      const at = format.findIndex((column) => column.toLowerCase() === name.toLowerCase());
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      return at === -1 ? "" : (values[at] ?? "").trim();
    };

    const startMs = parseTimestamp(field("Start"));
    const endMs = parseTimestamp(field("End"));
    if (startMs === null || endMs === null) {
      warnings.push(`dialogue ${String(cues.length + 1)} has an unreadable timestamp`);
      continue;
    }

    const body = stripAssMarkup(field("Text"));
    if (body === "") continue;
    const speaker = field("Name");
    cues.push(
      makeCue(
        cues.length + 1,
        startMs,
        endMs,
        body,
        warnings,
        speaker === "" ? undefined : speaker,
      ),
    );
  }

  if (cues.length === 0) throw new SubtitleParseError("ass", "no readable Dialogue lines");
  return { kind: "ass", cues, timed: true, warnings };
}

/** ASS override blocks, hard line breaks and hard spaces out of a Text field. */
export function stripAssMarkup(value: string): string {
  return (
    value
      // `{\an8}`, `{\pos(10,20)}`, `{\i1}` ... - drawing and styling, never content.
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\h/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/**
 * A script with no timings.
 *
 * Every non-empty line becomes a cue at time zero and `timed` is false, which is
 * the signal `ai.align` needs: this is text to be aligned against the audio, not
 * timings to be trusted.
 */
function parseTxt(text: string): ParsedSubtitles {
  const cues: SubtitleCue[] = [];
  for (const line of text.split("\n")) {
    const body = line.trim();
    if (body === "") continue;
    cues.push({ index: cues.length + 1, startMs: 0, endMs: 0, text: body });
  }
  if (cues.length === 0) throw new SubtitleParseError("txt", "the file is empty");
  return { kind: "txt", cues, timed: false, warnings: [] };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function splitBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
}

/** `split` that keeps everything after the `limit`-th separator in the last field. */
function splitLimited(value: string, separator: string, limit: number): string[] {
  const out: string[] = [];
  let rest = value;
  while (out.length < limit - 1) {
    const at = rest.indexOf(separator);
    if (at === -1) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  out.push(rest);
  return out;
}

/** `<i>`, `<b>`, `<v Name>` and friends; the text inside them is kept. */
export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function makeCue(
  index: number,
  startMs: number,
  endMs: number,
  text: string,
  warnings: string[],
  speaker?: string,
): SubtitleCue {
  if (endMs < startMs) {
    warnings.push(`cue ${String(index)} ends before it starts; the end was clamped`);
  }
  return {
    index,
    startMs,
    endMs: Math.max(startMs, endMs),
    text,
    ...(speaker === undefined || speaker === "" ? {} : { speaker }),
  };
}
