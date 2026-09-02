/**
 * The EDG + transcript endpoint descriptors A12/A11 expose.
 *
 * `@montaj/api-client` (A13/A14) does not carry these yet — `contract.test.ts`
 * there only checks descriptors that live in that package, and adding new ones
 * is outside this work package's file boundary (`apps/web/lib/edg/**` and
 * friends; not `packages/api-client/**`). The generated operation index
 * (`packages/api-client/src/generated/operations.ts`) already lists every route
 * below — it is regenerated from the API's own OpenAPI document — so these
 * descriptors are typed against ids that index proves exist, using the same
 * `defineEndpoint` helper the rest of the app uses. When A15's endpoints move
 * into `@montaj/api-client` itself (a follow-up, not this WP), this file
 * disappears and callers import the real hooks instead.
 *
 * Every response type here mirrors the DTOs in `apps/api/src/edg/edg.dto.ts`
 * and `apps/api/src/transcripts/transcripts.dto.ts` (read, not modified —
 * outside this WP's boundary).
 */
import { defineEndpoint } from "@montaj/api-client";
import type {
  EdgHot,
  EdgOp,
  EdgSource,
  OpRejection,
  Pass,
  Segment,
  TranscriptChunk,
} from "@montaj/edg";

export interface EdgDocumentResponse {
  readonly revision: number;
  readonly schemaVersion: number;
  readonly hot: EdgHot;
  readonly segments: Segment[];
  readonly nextCursor: string | null;
  readonly passes: Pass[];
  readonly updatedAt: string;
}

export interface SegmentPageResponse {
  readonly segments: Segment[];
  readonly nextCursor: string | null;
  readonly revision: number;
}

export interface OpBatchResponse {
  readonly revision: number;
  readonly applied: string[];
  readonly rebased: string[];
  readonly rejected: OpRejection[];
}

export interface OpBatchRequestBody {
  readonly baseRevision: number;
  readonly ops: EdgOp[];
  readonly clientOpIds: string[];
}

/** The `edg/conflict` 409's body — a widened `ApiError.details`. */
export interface OpConflictDetails {
  readonly latestRevision: number;
  readonly opsSince: EdgOp[];
  readonly conflicts?: TextConflict[];
}

export interface TextConflict {
  readonly opId: string;
  readonly target: "segment" | "word";
  readonly targetId: string;
  readonly script?: string;
  /** The text the local client submitted. */
  readonly yours: string;
  /** The text the server-side winner wrote. */
  readonly theirs: string;
}

export interface ResegmentRequestBody {
  readonly maxChars: number;
  readonly maxLines: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly dropFillers?: boolean;
}

export interface TranscriptManifest {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly language: string;
  readonly chunkCount: number;
  readonly durationMs: number;
  readonly createdAt: string;
}

export interface TranscriptChunkPageResponse {
  readonly transcript: TranscriptManifest;
  readonly chunks: TranscriptChunk[];
  readonly nextCursor: number | null;
}

export interface SpeakersPatchBody {
  readonly speakers: { readonly id: string; readonly name?: string; readonly color?: string }[];
}

/** `GET /projects/{id}/edg` — hot doc, revision, first page of segments and passes. */
export const getProjectEdg = defineEndpoint<void, EdgDocumentResponse>({
  method: "GET",
  path: "/projects/{projectId}/edg",
  auth: "bearer",
  operationId: "getProjectEdg",
});

/** `GET /projects/{id}/edg/segments` — later pages, `seq` order. */
export const listEdgSegments = defineEndpoint<void, SegmentPageResponse>({
  method: "GET",
  path: "/projects/{projectId}/edg/segments",
  auth: "bearer",
  operationId: "listEdgSegments",
});

/** `POST /projects/{id}/edg/ops` — the one write path (CONTRACTS §2). */
export const applyEdgOps = defineEndpoint<OpBatchRequestBody, OpBatchResponse>({
  method: "POST",
  path: "/projects/{projectId}/edg/ops",
  auth: "bearer",
  operationId: "applyEdgOps",
});

/** `POST /projects/{id}/edg/resegment` — server mints the `Resegment` op. */
export const resegmentEdg = defineEndpoint<ResegmentRequestBody, OpBatchResponse>({
  method: "POST",
  path: "/projects/{projectId}/edg/resegment",
  auth: "bearer",
  operationId: "resegmentEdg",
});

/** `GET /projects/{id}/transcript` — manifest + one page of chunks. */
export const getProjectTranscript = defineEndpoint<void, TranscriptChunkPageResponse>({
  method: "GET",
  path: "/projects/{projectId}/transcript",
  auth: "bearer",
  operationId: "getProjectTranscript",
});

/**
 * `PATCH /projects/{id}/transcript/speakers` — rename speakers.
 *
 * A11's `transcripts` surface (see its README's endpoint table) does not expose
 * this route; speaker names are transcript-level and there is nowhere else to
 * write them. Per the brief ("else defer with a TODO issue"), calling this in
 * the running system 404s and `renameSpeaker` in `store.ts` catches that and
 * surfaces `speakerRenameUnavailable` instead of throwing through the editor —
 * tracked as issue A15-1 (speaker rename backend) for a later work package.
 */
export const patchTranscriptSpeakers = defineEndpoint<SpeakersPatchBody, { speakers: unknown[] }>({
  method: "PATCH",
  path: "/projects/{projectId}/transcript/speakers",
  auth: "bearer",
  pending: "A15-1",
});

/** Every EDG source string a web client may claim; `worker` is server-only. */
export type WebEdgSource = Exclude<EdgSource, "worker">;
