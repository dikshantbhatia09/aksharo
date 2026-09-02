/**
 * Wire types for `/s/*`, `/projects/{id}/share-links`, `/projects/{id}/comments`
 * and `/batch/*` — mirrored from the API's own Zod schemas
 * (`apps/api/src/share/share.dto.ts`, `apps/api/src/batch/batch.dto.ts`) rather
 * than imported from them, the same reasoning `lib/billing/types.ts` gives:
 * this app has no dependency on `apps/api`, and extending
 * `packages/api-client` is outside this work package's file boundary.
 */

export type ShareLinkScope = "view" | "comment" | "approve";
export type ShareReportCategory = "ncii" | "impersonation" | "copyright" | "other";
export type ReviewStatus = "none" | "pending" | "approved" | "changes_requested";

export interface ShareLinkView {
  readonly id: string;
  readonly projectId: string;
  readonly token: string;
  readonly scope: ShareLinkScope;
  readonly hasPassword: boolean;
  readonly expiresAt: string | null;
  readonly maxViews: number | null;
  readonly viewCount: number;
  readonly clientTag: string | null;
  readonly reportCount: number;
  readonly revokedAt: string | null;
  readonly autoDisabled: boolean;
  readonly createdAt: string;
  readonly url: string;
}

export interface CreateShareLinkRequest {
  readonly scope: ShareLinkScope;
  readonly password?: string;
  readonly expiresAt?: string;
  readonly maxViews?: number;
  readonly clientTag?: string;
}

export interface ShareResolveResponse {
  readonly projectId: string;
  readonly title: string;
  readonly scope: ShareLinkScope;
  readonly requiresPassword: boolean;
  readonly unlocked: boolean;
  readonly expired: boolean;
  readonly revoked: boolean;
  readonly reviewStatus: ReviewStatus;
  readonly aspect: string;
}

export interface SharePreviewResponse {
  readonly proxyUrl: string;
  readonly durationMs: number | null;
  readonly aspect: string;
  /** `EdgProjection` (`@montaj/render-core`) — opaque here, passed straight to `CaptionStage`. */
  readonly projection: unknown;
}

export interface ReportAbuseRequest {
  readonly category: ShareReportCategory;
  readonly reporterContact?: string;
  readonly details?: string;
}

export interface ReportAbuseResponse {
  readonly id: string;
  readonly dueAt: string;
}

export interface ShareDecisionResponse {
  readonly projectId: string;
  readonly reviewStatus: ReviewStatus;
}

export interface CommentAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface CreateCommentRequest {
  readonly body: string;
  readonly atMs?: number;
  readonly segmentId?: string;
  readonly parentId?: string;
  readonly author?: CommentAuthor;
}

export interface CommentView {
  readonly id: string;
  readonly projectId: string;
  readonly shareLinkId: string | null;
  readonly authorId: string | null;
  readonly authorName: string | null;
  readonly body: string;
  readonly atMs: number | null;
  readonly segmentId: string | null;
  readonly parentId: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface BatchSettings {
  readonly languages?: readonly string[];
  readonly stylePresetId?: string;
  readonly exportPresetId?: string;
  readonly audioClean?: boolean;
}

export interface BatchQuoteRequest {
  readonly items: readonly { readonly durationMs: number }[];
}

export interface BatchQuote {
  readonly perItemTenths: readonly number[];
  readonly totalTenths: number;
  readonly totalCredits: string;
}

export interface CreateBatchProjectInput {
  readonly title: string;
  readonly folderId?: string;
  readonly clientTag?: string;
  readonly aspect?: "9:16" | "16:9" | "1:1" | "4:5";
  readonly sourceLanguage?: string;
}

export interface CreateBatchRequest {
  readonly projects: readonly CreateBatchProjectInput[];
  readonly folderId?: string;
  readonly clientTag?: string;
  readonly settings?: BatchSettings;
  readonly durationsMs?: readonly number[];
}

export interface BatchProjectStatus {
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly latestJobStatus: string | null;
  readonly latestJobType: string | null;
  readonly latestJobError: string | null;
}

export interface BatchView {
  readonly id: string;
  readonly workspaceId: string;
  readonly settings: BatchSettings;
  readonly creditsQuoted: string;
  readonly createdAt: string;
  readonly projects: readonly BatchProjectStatus[];
}
