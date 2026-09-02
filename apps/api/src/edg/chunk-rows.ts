import { CHUNK_SELECT, type ChunkRow } from "./edg.rows.js";

import type { PrismaTransaction } from "../common/prisma/prisma.service.js";

/**
 * The newest `transcript_chunks` row per `chunk_idx`, no newer than
 * `maxRevision` when one is given (A11d).
 *
 * `transcript_chunks` is unique on `(transcript_id, revision, chunk_idx)`, and a
 * row's own `revision` only ever advances when a **re-transcription** writes a
 * whole new generation of rows (`TranscriptsRepository.persist`). A word edit
 * (`EdgRepository.persistWords`, the `EditWord` op) patches a chunk's existing
 * row **in place** and bumps `transcripts.currentRevision` without touching that
 * row's own `revision` column — advancing the document's revision is not the
 * same event as advancing the transcript's, and only the former happens on an
 * edit. So "the chunk as of revision N" is never `WHERE revision = N`: it is the
 * newest row **at or before** N, which is what `EdgRepository` has always read
 * for the live document (unbounded — always "at or before the newest") and what
 * a pinned `GET /projects/{id}/transcript?revision=` reads too (bounded).
 *
 * Both `EdgRepository` and `TranscriptsRepository` import this — `transcripts`
 * already depends on `edg` (for `EdgService.initialise`), never the reverse, so
 * this lives here rather than manufacturing a new edge between the two modules.
 */
export async function newestChunkRows(
  client: PrismaTransaction,
  transcriptId: string,
  options: { readonly maxRevision?: number; readonly only?: readonly number[] } = {},
): Promise<ChunkRow[]> {
  const rows = await client.transcriptChunk.findMany({
    where: {
      transcriptId,
      ...(options.maxRevision === undefined ? {} : { revision: { lte: options.maxRevision } }),
      ...(options.only === undefined ? {} : { chunkIdx: { in: [...options.only] } }),
    },
    // Ascending chunk, then newest revision first, so the first row this loop
    // sees for a chunk index is always the one to keep — and the result is
    // already in chunk order, because `Map` preserves insertion order.
    orderBy: [{ chunkIdx: "asc" }, { revision: "desc" }],
    select: CHUNK_SELECT,
  });

  const newest = new Map<number, ChunkRow>();
  for (const row of rows) if (!newest.has(row.chunkIdx)) newest.set(row.chunkIdx, row);
  return [...newest.values()];
}
