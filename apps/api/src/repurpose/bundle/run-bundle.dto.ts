import { z } from "zod";

import { zodDto } from "../../common/index.js";

/** `POST /repurpose/runs/{runId}/download`: also every shape's clean cut. */
export const runDownloadSchema = z.object({ includeClean: z.boolean().default(false) }).strict();

export class RunDownloadDto extends zodDto(runDownloadSchema) {}
