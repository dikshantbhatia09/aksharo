import { z } from "zod";

import { EDG_SCHEMA_VERSION, EdgProjectionSchema } from "./document.js";
import { TranscriptChunkSchema } from "./transcript.js";

/**
 * A materialised EDG state (`edg_snapshots.snapshot`, D28). One is written every
 * `EdgRepository.snapshotEvery` revisions so restoring never replays the whole
 * op log, and `meta.schemaVersion` gates the migrations that transform it.
 *
 * `chunks` is optional because the transcript lives in its own table: the API
 * loads it separately, while an exported snapshot (a support bundle, a fixture,
 * a migration input) carries the words with it so `restore` and `replay` can
 * resolve word ids without a database.
 */
export const EdgSnapshotSchema = z
  .object({
    schemaVersion: z.literal(EDG_SCHEMA_VERSION),
    projection: EdgProjectionSchema,
    chunks: z.array(TranscriptChunkSchema).optional(),
  })
  .meta({
    id: "EdgSnapshot",
    title: "EdgSnapshot",
    description: "Materialised EDG projection at one revision (D28)",
  });

export type EdgSnapshot = z.infer<typeof EdgSnapshotSchema>;
