/**
 * Transcript injection (C06 brief §Scope 1): EDG segments/words -> Premiere Text-Based Editing
 * transcript for the sequence's in/out range, via `PremiereHost#importTranscript` (real adapter:
 * `Transcript.createImportTextSegmentsAction`, cited in `src/host/premiere.ts`). Idempotent:
 * `MockPremiereHost#importTranscript` (and, per Gate C, the real adapter) replaces only the
 * previously Aksharo-tagged transcript, so calling this twice never duplicates.
 */
import type { EdgSegmentLike } from "./types.js";
import type {
  FrameRange,
  PremiereHost,
  TranscriptImportResult,
  TranscriptSegmentInput,
} from "../host/premiere.js";

export interface InjectTranscriptInput {
  readonly sequenceId: string;
  readonly language: string;
  readonly range: FrameRange;
  readonly segments: readonly EdgSegmentLike[];
}

/** Drops hidden segments and deleted words — Premiere's transcript should mirror what a viewer
 * sees, not the full EDG history. */
export function buildTranscriptSegments(
  segments: readonly EdgSegmentLike[],
): TranscriptSegmentInput[] {
  return segments
    .filter((segment) => !segment.hidden)
    .map((segment) => ({
      segmentId: segment.id,
      ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
      words: segment.words
        .filter((word) => !word.deleted)
        .map((word) => ({
          wid: word.wid,
          text: word.t,
          startFrames: word.startFrames,
          endFrames: word.endFrames,
        })),
    }));
}

export async function injectTranscript(
  host: PremiereHost,
  input: InjectTranscriptInput,
): Promise<TranscriptImportResult> {
  const segments = buildTranscriptSegments(input.segments);
  return host.importTranscript({
    sequenceId: input.sequenceId,
    language: input.language,
    range: input.range,
    segments,
  });
}
