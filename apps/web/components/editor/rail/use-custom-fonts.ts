"use client";

/**
 * TanStack Query hooks over `fonts-endpoints.ts`, mirroring the shape
 * `@montaj/api-client`'s own hooks use (`useApiClient`/`useWorkspaceId`, a
 * `queryKey` under the workspace, `retry: false` on a 4xx) so the rail's
 * Custom Fonts tab looks and behaves like every other workspace-scoped list
 * in the app. Kept local for the same file-boundary reason as
 * `fonts-endpoints.ts` — see that file's doc comment.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient, useWorkspaceId, isApiError } from "@montaj/api-client";

import {
  fontEndpoints,
  type CompleteFontUploadRequest,
  type FontUploadTicket,
  type InitFontUploadRequest,
  type WorkspaceFontView,
} from "./fonts-endpoints";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

function retryPolicy(failureCount: number, error: Error): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function fontsQueryKey(workspaceId: string): readonly unknown[] {
  return ["ws", workspaceId, "fonts"] as const;
}

/** A workspace's custom fonts (`GET /workspaces/{id}/fonts`). */
export function useWorkspaceFonts(): UseQueryResult<WorkspaceFontView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: fontsQueryKey(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(fontEndpoints.list, { params: { id: workspaceId ?? "" } }),
  });
}

/** Begin a font upload: plan-limit check, a row, and a presigned single-shot PUT. */
export function useInitFontUpload(): UseMutationResult<
  FontUploadTicket,
  Error,
  InitFontUploadRequest
> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(fontEndpoints.init, { params: { id: workspaceId ?? "" }, body }),
  });
}

/** Attest the licence and sanitise/subset the uploaded font. */
export function useCompleteFontUpload(): UseMutationResult<
  WorkspaceFontView,
  Error,
  { fontId: string; body: CompleteFontUploadRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ fontId, body }) =>
      client.call(fontEndpoints.complete, {
        params: { id: workspaceId ?? "", fontId },
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fontsQueryKey(workspaceId ?? "none") });
    },
  });
}

export function useDeleteFont(): UseMutationResult<{ deleted: true }, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (fontId) =>
      client.call(fontEndpoints.remove, { params: { id: workspaceId ?? "", fontId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: fontsQueryKey(workspaceId ?? "none") });
    },
  });
}
