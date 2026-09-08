/**
 * Typed descriptors for the custom-fonts endpoints (`apps/api/src/fonts`).
 *
 * These are **not** added to `packages/api-client/src/endpoints.ts` — that file
 * is outside this work package's file boundary (K04:
 * `apps/web/components/editor/**` rail/toolbar components only). The backend
 * already ships the whole feature (init → presigned PUT → attest/sanitise/
 * subset → list/delete, `apps/api/src/fonts/fonts.service.ts`) and every route
 * below is already in the generated operation index
 * (`packages/api-client/src/generated/operations.ts`, tag `fonts`) — this
 * module just gives the rail's Custom Fonts tab a typed way to call it,
 * exactly the pattern A21 established for `apps/web/lib/export/endpoints.ts`
 * (see that file's own doc comment for the precedent). Folding these into the
 * shared `packages/api-client` file for every future consumer is a natural
 * one-line follow-up outside this brief's boundary — flagged in the final
 * report.
 */

import { defineEndpoint } from "@montaj/api-client";

/** A font's status as the workspace's own catalogue reports it. */
export type WorkspaceFontStatus = "pending" | "ready" | "failed";

/** Mirrors `apps/api/src/fonts/fonts.service.ts`'s `WorkspaceFontView`. */
export interface WorkspaceFontView {
  readonly id: string;
  readonly workspaceId: string;
  readonly family: string;
  readonly style: string;
  readonly status: WorkspaceFontStatus;
  readonly sanitised: boolean;
  readonly weight: number;
  readonly italic: boolean;
  readonly scripts: readonly string[];
  readonly sizeBytes: number | null;
  readonly woff2SizeBytes: number | null;
  readonly filename: string | null;
  readonly licenceAttestedBy: string | null;
  readonly attestedAt: string | null;
  readonly attestationVersion: string | null;
  readonly licenceNote: string | null;
  readonly servedOnlyToWorkspace: boolean;
  readonly createdAt: string;
}

export interface InitFontUploadRequest {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly family?: string;
  readonly scripts?: readonly string[];
}

export interface FontUploadTicket {
  readonly fontId: string;
  /** Single-shot presigned PUT — a font is far too small for multipart. */
  readonly url: string;
  readonly key: string;
  readonly expiresAt: string;
  readonly attestation: { readonly version: string; readonly text: string };
  readonly quota: { readonly used: number; readonly limit: number; readonly planKey: string };
  readonly font: WorkspaceFontView;
}

export interface CompleteFontUploadRequest {
  readonly licenceAttested: boolean;
  readonly licenceNote?: string;
  readonly attestationVersion?: string;
}

export const fontEndpoints = {
  init: defineEndpoint<InitFontUploadRequest, FontUploadTicket>({
    method: "POST",
    path: "/workspaces/{id}/fonts/init",
    auth: "bearer",
    operationId: "initFontUpload",
  }),
  complete: defineEndpoint<CompleteFontUploadRequest, WorkspaceFontView>({
    method: "POST",
    path: "/workspaces/{id}/fonts/{fontId}/complete",
    auth: "bearer",
    operationId: "completeFontUpload",
  }),
  list: defineEndpoint<void, WorkspaceFontView[]>({
    method: "GET",
    path: "/workspaces/{id}/fonts",
    auth: "bearer",
    operationId: "listWorkspaceFonts",
  }),
  remove: defineEndpoint<void, { deleted: true }>({
    method: "DELETE",
    path: "/workspaces/{id}/fonts/{fontId}",
    auth: "bearer",
    operationId: "deleteWorkspaceFont",
  }),
} as const;

/** The server's own cap (`apps/api/src/fonts/fonts.constants.ts`'s `MAX_FONT_UPLOAD_BYTES`) — mirrored here only for a friendly client-side pre-check; the server is authoritative. */
export const MAX_FONT_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Extensions the fonts pipeline accepts (`fonts.service.ts`'s `sfntExtensionFor`: everything but `.otf` is signed as `.ttf`, and the pipeline itself refuses anything that doesn't parse as a valid sfnt/woff2 font). */
export const ACCEPTED_FONT_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf"] as const;
