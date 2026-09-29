import { ClipCopySchema, type HighlightProposal } from "@montaj/repurpose-contracts";

import type { ClipCandidate, Prisma } from "@prisma/client";

/**
 * A moment's words for posting (2026-09-29), from `ai.highlights` to the
 * candidate row and on to the clip.
 *
 * The worker writes each proposal's `copy` (title, on-screen hook, description,
 * hashtags, text per platform) and the language model's `judgement` of it.
 * The candidate keeps both, and is titled by the copy's title when there is
 * one: that is the title a person would post, where the proposal's own title
 * is only the moment's first words. A clip made from the candidate starts from
 * the candidate's copy (`repurpose_clips.copy`), which the editor and a person
 * may then change without touching the candidate.
 */
export function candidateModelFields(proposal: HighlightProposal): {
  readonly title: string;
  readonly copy?: Prisma.InputJsonValue;
  readonly judgement?: Prisma.InputJsonValue;
} {
  const copy = proposal.copy;
  return {
    title: copy?.title ?? proposal.title,
    ...(copy === undefined ? {} : { copy: copy as unknown as Prisma.InputJsonValue }),
    ...(proposal.judgement === undefined
      ? {}
      : { judgement: proposal.judgement as unknown as Prisma.InputJsonValue }),
  };
}

/**
 * The copy a clip made from `candidate` starts with: the candidate's own, when
 * it is a whole `ClipCopySchema`, and nothing otherwise (the column's `{}`).
 * Checked again here because `clip_candidates.copy` is a JSON column: a row
 * from before copy existed, or one a person's moment created, holds `{}`.
 */
export function clipCopyOf(
  candidate: Pick<ClipCandidate, "copy">,
): Prisma.InputJsonValue | undefined {
  const parsed = ClipCopySchema.safeParse(candidate.copy);
  return parsed.success ? (parsed.data as unknown as Prisma.InputJsonValue) : undefined;
}
