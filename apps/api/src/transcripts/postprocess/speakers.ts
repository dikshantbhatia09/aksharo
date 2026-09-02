import type { Speaker, Word } from "@montaj/edg/schemas";

import type { Correction, StepResult } from "./corrections.js";

/**
 * Speaker label normalisation.
 *
 * Every diariser names its speakers differently — `SPEAKER_00`, `spk_1`, `S1`,
 * a raw cluster index — and the label reaches the caption UI, the export and the
 * `EdgHot.transcript.speakers` list. Normalising here means the rest of the
 * system sees one shape: `s1`, `s2`, … numbered by **first appearance in the
 * media**, not by whatever order the diariser's clustering happened to emit.
 *
 * First appearance is the only ordering a user can predict: `s1` is whoever spoke
 * first, which is almost always the host. It also makes the mapping stable across
 * a re-transcription of the same audio, so a colour assigned to `s2` in the editor
 * still points at the same person afterwards.
 *
 * Words with no speaker at all are left alone — a transcript that was never
 * diarised must not grow a fake speaker.
 */

export interface SpeakerNormalisation extends StepResult {
  /** The speakers, in first-appearance order, for `EdgHot.transcript.speakers`. */
  readonly speakers: readonly Speaker[];
  /** Original label → normalised id, for the audit trail. */
  readonly mapping: ReadonlyMap<string, string>;
}

/**
 * Renumber speaker labels over the **whole** transcript.
 *
 * Takes every chunk's words at once rather than one chunk at a time: numbering by
 * first appearance is a property of the media, and doing it per chunk would give
 * the second chunk its own `s1`.
 */
export function normaliseSpeakers(words: readonly Word[]): SpeakerNormalisation {
  const mapping = new Map<string, string>();
  for (const word of words) {
    const label = word.sp;
    if (label === undefined || label === "") continue;
    if (!mapping.has(label)) mapping.set(label, `s${String(mapping.size + 1)}`);
  }

  const corrections: Correction[] = [];
  const out = words.map((word) => {
    const label = word.sp;
    if (label === undefined || label === "") return word;
    const normalised = mapping.get(label);
    if (normalised === undefined || normalised === label) return word;
    corrections.push({
      step: "speakers",
      wordId: word.wid,
      before: word.t,
      after: word.t,
      reason: `speaker ${label} → ${normalised}`,
    });
    return { ...word, sp: normalised };
  });

  const speakers: Speaker[] = [...mapping.values()].map((id) => ({ id }));
  return { words: out, corrections, speakers, mapping };
}
