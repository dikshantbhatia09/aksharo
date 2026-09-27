/**
 * When a project's FIRST transcription may start, and what it is asked to hear.
 *
 * One definition, because four places start or reason about that transcription
 * — the producer (`TranscriptsService.transcribe`), the automatic start
 * (`AutoTranscribeTrigger`), a clips run's reconciler and the proxy's failure
 * handler — and two of them disagreeing is a run that says "transcribing" while
 * the producer answers 409, on every pass, for good.
 *
 * ### Audio first (clips pipeline W5, 2026-09-27)
 *
 * `ai.transcribe` reads one file, `audio16k.wav`, and `media.proxy` makes it
 * first, then spends most of its time on a 540p encode the transcription never
 * reads. Until now the key reached the row only with `status: "ready"` at the
 * very end, so transcription waited on the encode: 111 s on a 35-minute source,
 * about fifteen minutes on a three-hour one. The worker now writes the key back
 * the moment the file is stored, and a first transcription may start from then
 * on — the GPU transcribes while the CPU encodes.
 *
 * "From then on" is exactly: the probe has measured the media (a duration to
 * quote on, `has_audio` set — every probe writes it), the row is still being
 * prepared (`probing`), and the ASR audio's key is on it. `uploaded` does not
 * qualify even with a key: that is bytes that landed and have not been probed
 * yet, and a clip re-cut lands new bytes on the same row without clearing the
 * old derived keys (`MediaService.completeAcquisition`), so a key seen next to
 * `uploaded` can be the previous file's audio. (On a re-cut that stale key also
 * outlives the new probe, until the new proxy replaces it; a re-cut clip keeps
 * its editing document, and nothing here starts a transcription for a project
 * that has one.)
 *
 * The editing document still waits for what it needs: it is built from the
 * probe's dimensions (`TranscribeCompletionHandler.budgetsFor`,
 * `TranscriptDocumentService.ensure`), which the probe's completion writes
 * before it ever enqueues the proxy that writes this key.
 */

/** The media columns the decision reads. */
export interface TranscribableMedia {
  readonly status: string;
  readonly durationMs: number | null;
  readonly audio16kKey: string | null;
  readonly hasAudio: boolean | null;
}

/**
 * The ASR audio is on the row of media that is still being prepared: a first
 * transcription may start without waiting for the rest of `media.proxy`.
 */
export function audioReadyEarly(media: TranscribableMedia): boolean {
  return (
    media.status === "probing" &&
    typeof media.audio16kKey === "string" &&
    media.audio16kKey !== "" &&
    media.hasAudio === true &&
    media.durationMs !== null &&
    media.durationMs > 0
  );
}

/**
 * A first transcription can start on `media` now: it is `ready` with a measured
 * duration (as it always could), or its audio is ready early.
 */
export function firstTranscriptionCanStart(media: TranscribableMedia): boolean {
  if (media.durationMs === null || media.durationMs <= 0) return false;
  return media.status === "ready" || audioReadyEarly(media);
}

/**
 * The job key a first transcription of `mediaId` is enqueued under. It is what
 * makes the automatic start idempotent — it is asked twice now, once when the
 * audio lands and once when the media is ready, and a live job under this key
 * absorbs the second ask — and what a failed proxy's handler looks up to stop
 * a transcription of media that turned out unusable.
 */
export function firstTranscriptionJobKey(projectId: string, mediaId: string): string {
  return `transcribe:${projectId}:${mediaId}`;
}

/**
 * The language a person picks when they want the language detected. It is a
 * choice (a clips run defaults to it), not a language: nothing downstream may
 * see it as one. A hint wins outright wherever it is read — the worker's LID
 * (`decide_language`) and the API's own post-processing (`identifyLanguage`),
 * which would otherwise record the transcript, and then the project, as being
 * in a language called "auto".
 */
export const AUTO_DETECT_LANGUAGE = "auto";

/**
 * The language hints to send with a transcription, best first: blanks dropped,
 * and "auto" dropped, because asking for detection is sending no hint at all —
 * the path every worker lane already runs for a project with none.
 */
export function languageHints(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter((tag) => {
    const trimmed = tag.trim();
    return trimmed !== "" && trimmed.toLowerCase() !== AUTO_DETECT_LANGUAGE;
  });
}
