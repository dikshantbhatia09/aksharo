/**
 * Typed descriptors for the export endpoints (`apps/api/src/exports`).
 *
 * These are **not** added to `packages/api-client/src/endpoints.ts` — that
 * file is outside this work package's file boundary (`apps/web/lib/export/**`,
 * `apps/web/components/editor/export/**`, root `CHANGELOG.md` only). A21's
 * generated operation index (`packages/api-client/src/generated/operations.ts`)
 * already carries `exports` routes, so `defineEndpoint` here is checked against
 * the same generated index `contract.test.ts` uses — this module just doesn't
 * live in the shared file. Reported as a deviation in the final report; folding
 * these into `packages/api-client/src/endpoints.ts` for every future consumer
 * is a natural one-line follow-up outside this brief's boundary.
 */

import { defineEndpoint } from "@montaj/api-client";
import type { RenderManifest } from "@montaj/render-manifest";

import type { ExportCapabilitiesRequest } from "./types";

export interface ExportOptionsRequest {
  readonly brandAssetId?: string;
  readonly watermarkPosition?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  readonly watermarkOpacity?: number;
}

export interface SubtitleOptionsRequest {
  readonly formats: readonly ("srt" | "vtt" | "txt" | "md" | "ass")[];
  readonly scripts?: readonly ("roman" | "native" | "en")[];
}

export interface CreateExportRequest {
  readonly kind?: "video" | "subtitle";
  readonly preset?: "reels" | "shorts" | "youtube-4k" | "square" | "custom";
  readonly outputKind?: "video" | "alpha" | "greenscreen";
  readonly customWidth?: number;
  readonly customHeight?: number;
  readonly script?: "roman" | "native" | "en";
  readonly mode?: "auto" | "browser" | "cloud";
  readonly dropFillers?: boolean;
  readonly subtitle?: SubtitleOptionsRequest;
  readonly capabilities?: ExportCapabilitiesRequest;
  readonly options?: ExportOptionsRequest;
}

export interface ExportQuote {
  readonly tenths: number;
  readonly credits: string;
}

export interface ExportJobRef {
  readonly jobId: string;
  readonly status: string;
  readonly deduplicated: boolean;
}

export interface CreateExportResponse {
  readonly exportId: string;
  readonly path: "browser" | "cloud";
  readonly reasons: string[];
  readonly watermarked: boolean;
  readonly quote: ExportQuote;
  /** Present on the browser path only — an opaque object; parse it with `@montaj/render-manifest`. */
  readonly manifest?: Record<string, unknown>;
  readonly job?: ExportJobRef;
}

export interface ManifestCompleteRequest {
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly checksum: string;
}

export interface ManifestCompleteResponse {
  readonly exportId: string;
  readonly status: "succeeded";
  readonly downloadAvailable: boolean;
}

export const exportEndpoints = {
  create: defineEndpoint<CreateExportRequest, CreateExportResponse>({
    method: "POST",
    path: "/projects/{projectId}/exports",
    auth: "bearer",
  }),
  completeManifest: defineEndpoint<ManifestCompleteRequest, ManifestCompleteResponse>({
    method: "POST",
    path: "/exports/manifests/{manifestId}/complete",
    auth: "bearer",
  }),
} as const;

/** Narrows `CreateExportResponse.manifest` for the browser path. */
export function manifestFromResponse(
  response: CreateExportResponse,
): Record<string, unknown> | null {
  return response.path === "browser" && response.manifest !== undefined ? response.manifest : null;
}

export type { RenderManifest };
