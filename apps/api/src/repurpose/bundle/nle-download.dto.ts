import { z } from "zod";

import { VIDEO_SHAPES } from "@montaj/repurpose-contracts";

import { zodDto } from "../../common/index.js";

/**
 * `POST /repurpose/runs/{runId}/clips/{clipId}/nle-download` (2026-10-01):
 * which of the clip's shapes to open in an editing app. 9:16 when not said.
 */
export const nleDownloadSchema = z
  .object({
    shape: z.enum(VIDEO_SHAPES).default("9:16"),
  })
  .strict();

export class NleDownloadDto extends zodDto(nleDownloadSchema) {}
