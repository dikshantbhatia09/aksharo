import { Prisma } from "@prisma/client";

import {
  type EdgHot,
  EdgHotSchema,
  type Pass,
  type PassItem,
  type Segment,
  type TranscriptChunk,
  type Word,
} from "@montaj/edg/schemas";

/**
 * Row ↔ domain mapping for the `edg_*` tables.
 *
 * The engine's types are the contract (CONTRACTS §2), the rows are storage, and
 * this file is the only place the two meet. Two rules it exists to keep:
 *
 * * **Optional means absent, not null.** `toProjection` is canonical — two
 *   clients that applied the same ops must serialise the same bytes — so a
 *   segment with no `position` must have no `position` key, never `position:
 *   null`. Every mapper below drops empty optionals rather than passing the
 *   column through.
 * * **Nothing is validated per row on the read path.** A 9,000-segment document
 *   would pay for 9,000 Zod parses on every batch. The projection is validated
 *   where it is written whole — snapshots and `initialise` — which is the point
 *   at which a mapping bug would become durable.
 */

/** The columns the module reads from `edg_segments`; a narrow select, so a schema change is a type error. */
export const SEGMENT_SELECT = {
  id: true,
  seq: true,
  startWordId: true,
  endWordId: true,
  startMs: true,
  endMs: true,
  styleRef: true,
  textOverrides: true,
  emphasis: true,
  position: true,
  overrides: true,
  hidden: true,
  updatedAtRev: true,
  deletedAtRev: true,
} as const satisfies Prisma.EdgSegmentSelect;

export type SegmentRow = Prisma.EdgSegmentGetPayload<{ select: typeof SEGMENT_SELECT }>;

export const PASS_SELECT = {
  id: true,
  type: true,
  engine: true,
  params: true,
  status: true,
  jobId: true,
  createdAt: true,
} as const satisfies Prisma.EdgPassSelect;

export type PassRow = Prisma.EdgPassGetPayload<{ select: typeof PASS_SELECT }>;

export const PASS_ITEM_SELECT = {
  id: true,
  passId: true,
  kind: true,
  startMs: true,
  endMs: true,
  payload: true,
  keyframesRef: true,
  confidence: true,
  reason: true,
  state: true,
  licenceSnapshot: true,
} as const satisfies Prisma.EdgPassItemSelect;

export type PassItemRow = Prisma.EdgPassItemGetPayload<{ select: typeof PASS_ITEM_SELECT }>;

export const CHUNK_SELECT = {
  id: true,
  transcriptId: true,
  revision: true,
  chunkIdx: true,
  startMs: true,
  endMs: true,
  words: true,
  nextWordSeq: true,
} as const satisfies Prisma.TranscriptChunkSelect;

export type ChunkRow = Prisma.TranscriptChunkGetPayload<{ select: typeof CHUNK_SELECT }>;

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.keys(value).length === 0 ? undefined : (value as Record<string, unknown>);
}

function asArray<T>(value: Prisma.JsonValue | null): T[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value as T[];
}

/** `edg_segments` row → the frozen `Segment` of CONTRACTS §2. */
export function toSegment(row: SegmentRow): Segment {
  const textOverrides = asRecord(row.textOverrides) as Record<string, string> | undefined;
  const emphasis = asArray<Segment["emphasis"] extends (infer E)[] | undefined ? E : never>(
    row.emphasis,
  );
  const position = asRecord(row.position) as Segment["position"] | undefined;
  const overrides = asRecord(row.overrides);

  return {
    id: row.id,
    seq: row.seq,
    startWordId: row.startWordId as Segment["startWordId"],
    endWordId: row.endWordId as Segment["endWordId"],
    startMs: row.startMs,
    endMs: row.endMs,
    ...(row.styleRef === null ? {} : { styleRef: row.styleRef }),
    ...(textOverrides === undefined ? {} : { textOverrides }),
    ...(emphasis === undefined ? {} : { emphasis }),
    ...(position === undefined ? {} : { position }),
    ...(overrides === undefined ? {} : { overrides }),
    ...(row.hidden ? { hidden: true } : {}),
  };
}

/** The writable columns of `edg_segments`, for an insert or an update. */
export function segmentColumns(
  segment: Segment,
  revision: number,
): Omit<Prisma.EdgSegmentUncheckedCreateInput, "edgId"> {
  return {
    id: segment.id,
    seq: segment.seq,
    startWordId: segment.startWordId,
    endWordId: segment.endWordId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    styleRef: segment.styleRef ?? null,
    textOverrides: (segment.textOverrides ?? {}) as Prisma.InputJsonValue,
    emphasis: (segment.emphasis ?? []) as unknown as Prisma.InputJsonValue,
    position: (segment.position ?? Prisma.DbNull) as Prisma.InputJsonValue,
    overrides: (segment.overrides ?? Prisma.DbNull) as Prisma.InputJsonValue,
    hidden: segment.hidden === true,
    updatedAtRev: revision,
    deletedAtRev: null,
  };
}

/** `edg_pass_items` row → `PassItem`. The union is discriminated on `kind`. */
export function toPassItem(row: PassItemRow): PassItem {
  return {
    itemId: row.id,
    passId: row.passId,
    kind: row.kind,
    startMs: row.startMs,
    endMs: row.endMs,
    payload: (asRecord(row.payload) ?? {}) as never,
    ...(row.keyframesRef === null ? {} : { keyframesRef: row.keyframesRef }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    state: row.state,
    ...(asRecord(row.licenceSnapshot) === undefined
      ? {}
      : { licenceSnapshot: asRecord(row.licenceSnapshot) }),
  } as PassItem;
}

export function passItemColumns(
  item: PassItem,
): Omit<Prisma.EdgPassItemUncheckedCreateInput, "edgId"> {
  return {
    id: item.itemId,
    passId: item.passId,
    kind: item.kind,
    startMs: item.startMs,
    endMs: item.endMs,
    payload: item.payload as Prisma.InputJsonValue,
    keyframesRef: item.keyframesRef ?? null,
    confidence: item.confidence ?? null,
    reason: item.reason ?? null,
    state: item.state,
    licenceSnapshot: (item.licenceSnapshot ?? Prisma.DbNull) as Prisma.InputJsonValue,
  };
}

/** `edg_passes` row (+ its items) → `Pass`. */
export function toPass(row: PassRow, items: PassItem[]): Pass {
  return {
    passId: row.id,
    type: row.type,
    engine: row.engine,
    params: (asRecord(row.params) ?? {}) as Record<string, unknown>,
    status: row.status,
    ...(row.jobId === null ? {} : { jobId: row.jobId }),
    createdAt: row.createdAt.toISOString(),
    items,
  };
}

export function passColumns(pass: Pass): Omit<Prisma.EdgPassUncheckedCreateInput, "edgId"> {
  return {
    id: pass.passId,
    type: pass.type,
    engine: pass.engine,
    params: pass.params as Prisma.InputJsonValue,
    status: pass.status,
    jobId: pass.jobId ?? null,
  };
}

/** `transcript_chunks` row → the chunk the word index is built from. */
export function toChunk(row: ChunkRow): TranscriptChunk {
  return {
    chunkIdx: row.chunkIdx,
    startMs: row.startMs,
    endMs: row.endMs,
    words: (asArray<Word>(row.words) ?? []) as Word[],
  };
}

/**
 * `edg_documents.doc` → `EdgHot`, validated.
 *
 * The hot document is under 64 KB and read once per request, so this is the one
 * place a Zod parse is affordable — and it is also the place a corrupt document
 * would otherwise flow silently into the engine.
 */
export function toHot(doc: Prisma.JsonValue): EdgHot {
  return EdgHotSchema.parse(doc);
}

/** `nextWordSeq` for a chunk: one past the highest `n` any of its words has ever used (D28). */
export function nextWordSeqOf(chunk: TranscriptChunk, current: number): number {
  let highest = current - 1;
  for (const word of chunk.words) {
    const n = Number(word.wid.split(":")[1] ?? "0");
    if (n > highest) highest = n;
  }
  return highest + 1;
}
