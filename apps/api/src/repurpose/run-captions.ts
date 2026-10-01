/**
 * A clips run started with captions the person already has (2026-10-01,
 * OpusClip's "upload SRT"): what the run row keeps about them.
 *
 * The file itself is stored the way the editor's subtitle import stores one
 * (S-03): parsed into a cue list, written as a JSON sidecar in the derived
 * bucket and recorded as a `subtitle` media row of the run's source project
 * (`SubtitleImportService.stash`), so retention, purge dates and the project
 * cascade cover it with no special case. The run's frozen `config.captions`
 * names that row, and that is all it names: no text, no address. A linked
 * file's address stays on the sidecar (as an editor import's does), never on
 * the run.
 *
 * What it changes is one step. When the source can be heard,
 * `AutoTranscribeTrigger` asks `RunCaptionsAligner` first: it aligns the cues
 * to the audio (`ai.align`, mode `import`, 0 credits) instead of starting a
 * paid transcription, and the align's completion writes the transcript and the
 * editing document exactly as an editor import's does (CLAUDE.md section 13's
 * invariant). Moments are found from that transcript as from any other.
 *
 * Absent reads as a run without captions, as every run from before was.
 */

/** Which caption formats a run may start with: the two that carry their own timings. */
export const RUN_CAPTION_KINDS = ["srt", "vtt"] as const;
export type RunCaptionKind = (typeof RUN_CAPTION_KINDS)[number];

/** `repurpose_runs.config.captions`. */
export interface RunCaptions {
  /** The `subtitle` media row of the source project that holds the cues. */
  readonly subtitleMediaId: string;
  readonly kind: RunCaptionKind;
  readonly cueCount: number;
  /** Sent inline (a file picked on the form) or fetched from a link. */
  readonly from: "file" | "url";
}

/** The run's captions, or `null` for a run that transcribes its video as usual. */
export function runCaptionsOf(run: { readonly config: unknown }): RunCaptions | null {
  const config = run.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return null;
  const raw = (config as Record<string, unknown>)["captions"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const captions = raw as Record<string, unknown>;
  const subtitleMediaId = captions["subtitleMediaId"];
  const kind = captions["kind"];
  if (typeof subtitleMediaId !== "string" || subtitleMediaId === "") return null;
  if (kind !== "srt" && kind !== "vtt") return null;
  const cueCount = captions["cueCount"];
  return {
    subtitleMediaId,
    kind,
    cueCount: typeof cueCount === "number" && Number.isFinite(cueCount) ? cueCount : 0,
    from: captions["from"] === "url" ? "url" : "file",
  };
}

/**
 * The language the captions are written in, for the transcript they become.
 *
 * A run's spoken language may be `"auto"` - detect it - which is a request to a
 * transcriber, not a language a transcript can carry. Captions are text, so the
 * script decides it: any Devanagari is Hindi, anything else English, the same
 * two lanes the transcription itself routes between. A language the person
 * picked is kept as it is.
 */
export function captionsLanguageOf(
  sourceLanguage: string | null,
  cues: readonly { readonly text: string }[],
): string {
  const picked = sourceLanguage?.trim() ?? "";
  if (picked !== "" && picked !== "auto") return picked;
  return cues.some((cue) => /[ऀ-ॿ]/.test(cue.text)) ? "hi" : "en";
}
