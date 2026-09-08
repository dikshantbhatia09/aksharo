"use client";

/** TanStack Query hooks over `brand-assets-endpoints.ts` — see that file's doc comment. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient, useWorkspaceId, isApiError } from "@montaj/api-client";

import {
  brandAssetEndpoints,
  type BrandAssetUploadTicket,
  type BrandAssetView,
  type CreateBrandAssetRequest,
} from "./brand-assets-endpoints";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

function retryPolicy(failureCount: number, error: Error): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

function brandAssetsQueryKey(workspaceId: string): readonly unknown[] {
  return ["ws", workspaceId, "brandAssets"] as const;
}

export function useBrandAssets(): UseQueryResult<BrandAssetView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: brandAssetsQueryKey(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(brandAssetEndpoints.list, { params: { id: workspaceId ?? "" } }),
  });
}

export function useCreateBrandAsset(): UseMutationResult<
  BrandAssetUploadTicket,
  Error,
  CreateBrandAssetRequest
> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body) =>
      client.call(brandAssetEndpoints.create, { params: { id: workspaceId ?? "" }, body }),
  });
}

/** No response body to invalidate off of directly — call `refetch()` on `useBrandAssets()` once the PUT settles. */
export function useDeleteBrandAsset(): UseMutationResult<void, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (assetId) =>
      client.call(brandAssetEndpoints.remove, { params: { id: workspaceId ?? "", assetId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: brandAssetsQueryKey(workspaceId ?? "none") });
    },
  });
}
