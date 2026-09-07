/**
 * Typed descriptors for the brand-assets endpoints
 * (`apps/api/src/exports/brand-assets.controller.ts`) — a workspace's
 * reusable watermark/logo PNGs, already fully built server-side (create with
 * a presigned PUT, list, delete) but with no frontend caller anywhere yet
 * (grepped `apps/web` for "brandAsset": zero hits outside this module).
 *
 * K04's Library rail tab surfaces this "as-is" per the brief's instruction to
 * reuse an existing reusable-asset concept rather than invent one — this is
 * that concept: images meant to be reused across projects (unlike
 * project-scoped `media`), which is the closest match this app has today to
 * Kalakar's Library tab.
 *
 * Kept local rather than added to `packages/api-client/src/endpoints.ts` for
 * the same file-boundary reason as `fonts-endpoints.ts` — see that file's doc
 * comment, and `apps/web/lib/export/endpoints.ts`'s (the precedent A21 set
 * for exactly this situation).
 */

import { defineEndpoint } from "@montaj/api-client";

export interface BrandAssetView {
  readonly id: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes?: number | null;
  readonly createdAt: string;
}

export interface CreateBrandAssetRequest {
  readonly contentType: "image/png";
  readonly sizeBytes: number;
}

export interface BrandAssetUploadTicket {
  readonly id: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

export const brandAssetEndpoints = {
  create: defineEndpoint<CreateBrandAssetRequest, BrandAssetUploadTicket>({
    method: "POST",
    path: "/workspaces/{id}/brand-assets",
    auth: "bearer",
    operationId: "createBrandAsset",
  }),
  list: defineEndpoint<void, BrandAssetView[]>({
    method: "GET",
    path: "/workspaces/{id}/brand-assets",
    auth: "bearer",
    operationId: "listBrandAssets",
  }),
  remove: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/workspaces/{id}/brand-assets/{assetId}",
    auth: "bearer",
    operationId: "deleteBrandAsset",
  }),
} as const;

/** The server's own cap (`exports.dto.ts`'s `BrandAssetCreateRequest`), mirrored for a friendly pre-check only. */
export const MAX_BRAND_ASSET_BYTES = 5 * 1024 * 1024;
