/**
 * Typed endpoint descriptors for `/s/*` (public), `/projects/{id}/share-links`,
 * `/projects/{id}/comments` and `/batch/*` — the same `defineEndpoint` shape
 * `lib/billing/endpoints.ts` uses, kept local to `apps/web` for the reason
 * `lib/share/types.ts`'s header explains.
 *
 * `auth: "public"` on every `/s/:token` route means `ApiClient` never attaches
 * a bearer token to it — correct, since a share link's own token (and, once
 * unlocked, `X-Share-Session`) is the credential, not a signed-in session.
 */

import { defineEndpoint } from "@montaj/api-client";

import type {
  BatchQuote,
  BatchQuoteRequest,
  BatchView,
  CommentView,
  CreateBatchRequest,
  CreateCommentRequest,
  CreateShareLinkRequest,
  ReportAbuseRequest,
  ReportAbuseResponse,
  ShareDecisionResponse,
  ShareLinkView,
  SharePreviewResponse,
  ShareResolveResponse,
} from "./types";

export const shareEndpoints = {
  resolve: defineEndpoint<void, ShareResolveResponse>({
    method: "GET",
    path: "/s/{token}",
    auth: "public",
  }),
  preview: defineEndpoint<void, SharePreviewResponse>({
    method: "GET",
    path: "/s/{token}/preview",
    auth: "public",
  }),
  unlock: defineEndpoint<{ readonly password: string }, { readonly session: string }>({
    method: "POST",
    path: "/s/{token}/unlock",
    auth: "public",
  }),
  report: defineEndpoint<ReportAbuseRequest, ReportAbuseResponse>({
    method: "POST",
    path: "/s/{token}/report",
    auth: "public",
  }),
  decide: defineEndpoint<
    { readonly decision: "approved" | "changes_requested" },
    ShareDecisionResponse
  >({
    method: "POST",
    path: "/s/{token}/decision",
    auth: "public",
  }),
  listComments: defineEndpoint<void, CommentView[]>({
    method: "GET",
    path: "/s/{token}/comments",
    auth: "public",
  }),
  addComment: defineEndpoint<CreateCommentRequest, CommentView>({
    method: "POST",
    path: "/s/{token}/comments",
    auth: "public",
  }),

  // Owner side — bearer auth, mounted under a project.
  createLink: defineEndpoint<CreateShareLinkRequest, ShareLinkView>({
    method: "POST",
    path: "/projects/{projectId}/share-links",
    auth: "bearer",
  }),
  listLinks: defineEndpoint<void, ShareLinkView[]>({
    method: "GET",
    path: "/projects/{projectId}/share-links",
    auth: "bearer",
  }),
  revokeLink: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/projects/{projectId}/share-links/{shareLinkId}",
    auth: "bearer",
  }),
  listProjectComments: defineEndpoint<void, CommentView[]>({
    method: "GET",
    path: "/projects/{projectId}/comments",
    auth: "bearer",
  }),
  addProjectComment: defineEndpoint<CreateCommentRequest, CommentView>({
    method: "POST",
    path: "/projects/{projectId}/comments",
    auth: "bearer",
  }),
  resolveComment: defineEndpoint<{ readonly resolved: boolean }, CommentView>({
    method: "PATCH",
    path: "/projects/{projectId}/comments/{commentId}",
    auth: "bearer",
  }),
} as const;

export const batchEndpoints = {
  quote: defineEndpoint<BatchQuoteRequest, BatchQuote>({
    method: "POST",
    path: "/batch/quote",
    auth: "bearer",
  }),
  create: defineEndpoint<CreateBatchRequest, BatchView>({
    method: "POST",
    path: "/batch",
    auth: "bearer",
  }),
  apply: defineEndpoint<{ readonly settings?: CreateBatchRequest["settings"] }, BatchView>({
    method: "POST",
    path: "/batch/{batchId}/apply",
    auth: "bearer",
  }),
  get: defineEndpoint<void, BatchView>({
    method: "GET",
    path: "/batch/{batchId}",
    auth: "bearer",
  }),
} as const;
