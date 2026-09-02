"use client";

/**
 * TanStack Query hooks over `endpoints.ts` for the public `/s/:token` surface
 * and the owner's share-link panel (B15 increment 2). Same conventions
 * `lib/billing/hooks.ts` documents: a 4xx never retries, a mutation that
 * changes something else on screen invalidates that query.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isApiError, useApiClient } from "@montaj/api-client";

import { SHARE_SESSION_HEADER } from "./constants";
import { batchEndpoints, shareEndpoints } from "./endpoints";
import { getShareSession, setShareSession } from "./session";

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
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

export const shareQueryKeys = {
  resolve: (token: string) => ["share", token, "resolve"] as const,
  preview: (token: string) => ["share", token, "preview"] as const,
  comments: (token: string) => ["share", token, "comments"] as const,
  links: (projectId: string) => ["share-links", projectId] as const,
  projectComments: (projectId: string) => ["project-comments", projectId] as const,
  batch: (batchId: string) => ["batch", batchId] as const,
} as const;

function retryPolicy(failureCount: number, error: Error): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/** The current unlock header for `token`, or `{}` when there is none yet. */
function sessionHeaders(token: string): Record<string, string> {
  const session = getShareSession(token);
  return session === undefined ? {} : { [SHARE_SESSION_HEADER]: session };
}

export function useShareResolve(token: string): UseQueryResult<ShareResolveResponse> {
  const client = useApiClient();
  return useQuery({
    queryKey: shareQueryKeys.resolve(token),
    queryFn: () =>
      client.call(shareEndpoints.resolve, {
        params: { token },
        headers: sessionHeaders(token),
      }),
    retry: retryPolicy,
  });
}

export function useSharePreview(
  token: string,
  enabled: boolean,
): UseQueryResult<SharePreviewResponse> {
  const client = useApiClient();
  return useQuery({
    queryKey: shareQueryKeys.preview(token),
    queryFn: () =>
      client.call(shareEndpoints.preview, {
        params: { token },
        headers: sessionHeaders(token),
      }),
    enabled,
    retry: retryPolicy,
  });
}

export function useUnlockShareLink(
  token: string,
): UseMutationResult<{ session: string }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      client.call(shareEndpoints.unlock, { params: { token }, body: { password } }),
    onSuccess: (result) => {
      setShareSession(token, result.session);
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.resolve(token) });
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.preview(token) });
    },
  });
}

export function useReportShareLink(
  token: string,
): UseMutationResult<ReportAbuseResponse, Error, ReportAbuseRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: ReportAbuseRequest) =>
      client.call(shareEndpoints.report, { params: { token }, body }),
  });
}

export function useDecideShareLink(
  token: string,
): UseMutationResult<ShareDecisionResponse, Error, "approved" | "changes_requested"> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (decision: "approved" | "changes_requested") =>
      client.call(shareEndpoints.decide, { params: { token }, body: { decision } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.resolve(token) });
    },
  });
}

export function useShareComments(token: string, enabled: boolean): UseQueryResult<CommentView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: shareQueryKeys.comments(token),
    queryFn: () =>
      client.call(shareEndpoints.listComments, {
        params: { token },
        headers: sessionHeaders(token),
      }),
    enabled,
    retry: retryPolicy,
  });
}

export function useAddShareComment(
  token: string,
): UseMutationResult<CommentView, Error, CreateCommentRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCommentRequest) =>
      client.call(shareEndpoints.addComment, {
        params: { token },
        body,
        headers: sessionHeaders(token),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.comments(token) });
    },
  });
}

// --- Owner side (bearer auth) ------------------------------------------------

export function useProjectShareLinks(projectId: string): UseQueryResult<ShareLinkView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: shareQueryKeys.links(projectId),
    queryFn: () => client.call(shareEndpoints.listLinks, { params: { projectId } }),
    retry: retryPolicy,
  });
}

export function useCreateShareLink(
  projectId: string,
): UseMutationResult<ShareLinkView, Error, CreateShareLinkRequest> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateShareLinkRequest) =>
      client.call(shareEndpoints.createLink, { params: { projectId }, body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.links(projectId) });
    },
  });
}

export function useRevokeShareLink(projectId: string): UseMutationResult<void, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (shareLinkId: string) =>
      client.call(shareEndpoints.revokeLink, { params: { projectId, shareLinkId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.links(projectId) });
    },
  });
}

// --- Batch --------------------------------------------------------------

export function useBatchQuote(): UseMutationResult<BatchQuote, Error, BatchQuoteRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: BatchQuoteRequest) => client.call(batchEndpoints.quote, { body }),
  });
}

export function useCreateBatch(): UseMutationResult<BatchView, Error, CreateBatchRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: CreateBatchRequest) => client.call(batchEndpoints.create, { body }),
  });
}

export function useApplyBatch(
  batchId: string,
): UseMutationResult<BatchView, Error, CreateBatchRequest["settings"]> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: CreateBatchRequest["settings"]) =>
      client.call(batchEndpoints.apply, { params: { batchId }, body: { settings } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: shareQueryKeys.batch(batchId) });
    },
  });
}

export function useBatch(batchId: string | undefined): UseQueryResult<BatchView> {
  const client = useApiClient();
  return useQuery({
    queryKey: shareQueryKeys.batch(batchId ?? ""),
    queryFn: () => client.call(batchEndpoints.get, { params: { batchId: batchId ?? "" } }),
    enabled: batchId !== undefined,
    retry: retryPolicy,
    // Batch progress moves on its own (workers finish jobs); poll while a
    // caller keeps this hook mounted, same reasoning `UploadTray` polls.
    refetchInterval: 4000,
  });
}
