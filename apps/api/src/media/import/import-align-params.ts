import type { SubtitleCue, SubtitleKind } from "./subtitle-parsers.js";

/**
 * The stored cue list of an imported subtitle file, and the `ai.align` request
 * built from it (S-03, B15 §6) - one place for both, because two producers now
 * write the same job: the editor's import (`SubtitleImportService`, the moment
 * the file arrives) and a clips run started with its own captions
 * (`RunCaptionsAligner`, 2026-10-01, OpusClip's "upload SRT"), which waits until
 * the video can be heard and reads the cues back from the sidecar.
 *
 * `AlignCompletionHandler.handleImport` rebuilds the words of each cue from the
 * flat answer with `cueWordCounts`, so the counts and the texts below must come
 * from the same normalisation - which is why neither producer builds them by
 * hand any more.
 */

/** Version stamp on the stored sidecar, so a later reader knows the shape. */
export const SUBTITLE_SIDECAR_VERSION = 1;

/** The JSON sidecar `SubtitleImportService` writes under `subtitleKey(...)`. */
export interface SubtitleSidecar {
  readonly version: number;
  readonly kind: SubtitleKind;
  readonly timed: boolean;
  readonly language: string | null;
  readonly alignsMediaId: string | null;
  readonly sourceUrl: string | null;
  readonly importedAt: string;
  readonly cues: readonly SubtitleCue[];
}

/** One cue's text as the aligner is given it: single spaces, no newlines. */
export function cueText(cue: Pick<SubtitleCue, "text">): string {
  return cue.text.replace(/\s+/g, " ").trim();
}

/** The `ai.align` params of an import (`mode: "import"`, `ImportAlignParams`). */
export function importAlignParams(input: {
  readonly transcriptId: string;
  readonly subtitleMediaId: string;
  readonly subtitleKey: string;
  readonly subtitleBucket: string;
  readonly mediaId: string | null;
  readonly kind: SubtitleKind;
  readonly timed: boolean;
  readonly language: string | null;
  readonly cues: readonly Pick<SubtitleCue, "startMs" | "endMs" | "text">[];
}): Record<string, unknown> {
  return {
    // B15 §6: the worker's own contract (`ai.align`) needs
    // `segments: [{startMs, endMs, text}]` built from the cues, not a
    // reference to the sidecar it cannot read on its own.
    mode: "import",
    transcriptId: input.transcriptId,
    subtitleMediaId: input.subtitleMediaId,
    subtitleKey: input.subtitleKey,
    subtitleBucket: input.subtitleBucket,
    mediaId: input.mediaId,
    kind: input.kind,
    timed: input.timed,
    cueCount: input.cues.length,
    language: input.language,
    segments: input.cues.map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cueText(cue),
    })),
    cueWordCounts: input.cues.map((cue) => cueText(cue).split(" ").filter(Boolean).length),
  };
}

/**
 * A stored sidecar read back, or `null` when the bytes are not one: the run's
 * aligner then falls back to transcription rather than enqueue nonsense.
 */
export function parseSidecar(raw: string): SubtitleSidecar | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["version"] !== SUBTITLE_SIDECAR_VERSION || !Array.isArray(record["cues"])) {
    return null;
  }
  const cues: SubtitleCue[] = [];
  for (const entry of record["cues"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const cue = entry as Record<string, unknown>;
    if (
      typeof cue["startMs"] !== "number" ||
      typeof cue["endMs"] !== "number" ||
      typeof cue["text"] !== "string" ||
      typeof cue["index"] !== "number"
    ) {
      return null;
    }
    cues.push({
      index: cue["index"],
      startMs: cue["startMs"],
      endMs: cue["endMs"],
      text: cue["text"],
      ...(typeof cue["speaker"] === "string" ? { speaker: cue["speaker"] } : {}),
    });
  }
  const kind = record["kind"];
  if (kind !== "srt" && kind !== "vtt" && kind !== "ass" && kind !== "txt") return null;
  return {
    version: SUBTITLE_SIDECAR_VERSION,
    kind,
    timed: record["timed"] === true,
    language: typeof record["language"] === "string" ? record["language"] : null,
    alignsMediaId: typeof record["alignsMediaId"] === "string" ? record["alignsMediaId"] : null,
    sourceUrl: typeof record["sourceUrl"] === "string" ? record["sourceUrl"] : null,
    importedAt: typeof record["importedAt"] === "string" ? record["importedAt"] : "",
    cues,
  };
}

/**
 * The cues of a whole video, as the part of it a run processed hears them.
 *
 * A link run downloads only a window of a long video (2026-09-27), so its
 * audio file starts at `startMs` of the source while a caption file the person
 * has is timed on the source's own clock. Cues that end before the window or
 * start after it are dropped; the rest are moved onto the file's clock and cut
 * at its edges. `endMs` null is a window that runs to the end (or no window).
 */
export function cuesInWindow<T extends Pick<SubtitleCue, "startMs" | "endMs">>(
  cues: readonly T[],
  window: { readonly startMs: number; readonly endMs: number | null },
): T[] {
  const out: T[] = [];
  for (const cue of cues) {
    if (cue.endMs <= window.startMs) continue;
    if (window.endMs !== null && cue.startMs >= window.endMs) continue;
    const startMs = Math.max(0, cue.startMs - window.startMs);
    const endMs =
      (window.endMs === null ? cue.endMs : Math.min(cue.endMs, window.endMs)) - window.startMs;
    if (endMs <= startMs) continue;
    out.push({ ...cue, startMs, endMs });
  }
  return out;
}
