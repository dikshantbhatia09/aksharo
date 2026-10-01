import { z } from "zod";

import { zodDto } from "../../common/index.js";

/** The most clips one selection may name (a run has at most 40 moments, plus re-timed ones). */
export const MAX_SELECTED_CLIPS = 100;

const clipId = z.string().min(1).max(64);

/**
 * `POST /repurpose/runs/{runId}/download`: also every shape's clean cut, and
 * (2026-10-01) only the clips picked; without `clipIds`, every clip.
 */
export const runDownloadSchema = z
  .object({
    includeClean: z.boolean().default(false),
    clipIds: z.array(clipId).min(1).max(MAX_SELECTED_CLIPS).optional(),
  })
  .strict();

export class RunDownloadDto extends zodDto(runDownloadSchema) {}

/** `GET /repurpose/runs/{runId}/download?clipIds=a,b`: the summary of a selection. */
export const runDownloadQuerySchema = z
  .object({
    clipIds: z
      .string()
      .min(1)
      .max(MAX_SELECTED_CLIPS * 65)
      .optional(),
  })
  .strict();

export class RunDownloadQueryDto extends zodDto(runDownloadQuerySchema) {}

/** The ids a summary's `clipIds` names, or `undefined` for every clip. */
export function selectedClipIds(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = [
    ...new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    ),
  ];
  return ids.length === 0 ? undefined : ids.slice(0, MAX_SELECTED_CLIPS);
}
