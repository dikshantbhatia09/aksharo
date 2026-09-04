"use client";

/**
 * TanStack Query hooks over `endpoints.ts`. Same rules `packages/api-client/
 * src/hooks.ts` documents for its own hooks: a workspace-scoped query is keyed
 * by the workspace id, nothing retries a 4xx, and a mutation that changes
 * something the shell shows elsewhere invalidates that query rather than
 * trusting a stale cache.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";

import { billingEndpoints, invoiceEndpoints, workspaceBillingEndpoints } from "./endpoints";

import type {
  CheckoutRequest,
  CheckoutResponse,
  CreditsSummary,
  InvoiceDownload,
  InvoiceRow,
  MandateView,
  PassCheckoutResponse,
  PaymentMethodView,
  PlanView,
  SubscriptionView,
  TaxProfileRequest,
  UsagePage,
  WorkspaceBillingView,
} from "./types";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

export const billingQueryKeys = {
  plans: () => ["billing", "plans"] as const,
  subscription: (workspaceId: string) => ["billing", workspaceId, "subscription"] as const,
  mandates: (workspaceId: string) => ["billing", workspaceId, "mandates"] as const,
  paymentMethods: (workspaceId: string) => ["billing", workspaceId, "payment-methods"] as const,
  workspace: (workspaceId: string) => ["billing", workspaceId, "workspace"] as const,
  credits: (workspaceId: string) => ["billing", workspaceId, "credits"] as const,
  usage: (workspaceId: string) => ["billing", workspaceId, "usage"] as const,
  invoices: (workspaceId: string) => ["billing", workspaceId, "invoices"] as const,
} as const;

function retryPolicy(failureCount: number, error: Error): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/** `true` for a 404 (`common/not_found`) — B05's `/invoices` may not exist yet. */
function isRouteMissing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

// --- Plans (public, no workspace) -------------------------------------------

export function usePlans(): UseQueryResult<PlanView[]> {
  const client = useApiClient();
  return useQuery({
    queryKey: billingQueryKeys.plans(),
    staleTime: 300_000,
    retry: retryPolicy,
    queryFn: () => client.call(billingEndpoints.plans),
  });
}

// --- Subscription lifecycle ---------------------------------------------------

export function useSubscription(): UseQueryResult<SubscriptionView | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.subscription(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(billingEndpoints.subscription),
  });
}

export function useCheckout(): UseMutationResult<CheckoutResponse, Error, CheckoutRequest> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body: CheckoutRequest) => client.call(billingEndpoints.checkout, { body }),
  });
}

export function usePassCheckout(): UseMutationResult<
  PassCheckoutResponse,
  Error,
  { readonly kind: "first_export" | "week_pass" | "pay_once"; readonly planKey?: string }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body) => client.call(billingEndpoints.passCheckout, { body }),
  });
}

export function useTopupCheckout(): UseMutationResult<
  PassCheckoutResponse,
  Error,
  { readonly credits: number }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (body) => client.call(billingEndpoints.topupCheckout, { body }),
  });
}

function invalidateSubscriptionAndCredits(
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string | null,
): void {
  if (workspaceId === null) return;
  void queryClient.invalidateQueries({ queryKey: billingQueryKeys.subscription(workspaceId) });
  void queryClient.invalidateQueries({ queryKey: billingQueryKeys.credits(workspaceId) });
}

export function useCancelSubscription(): UseMutationResult<SubscriptionView, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: () => client.call(billingEndpoints.cancelSubscription),
    onSuccess: () => {
      invalidateSubscriptionAndCredits(queryClient, workspaceId);
    },
  });
}

export function useResumeSubscription(): UseMutationResult<SubscriptionView, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: () => client.call(billingEndpoints.resumeSubscription),
    onSuccess: () => {
      invalidateSubscriptionAndCredits(queryClient, workspaceId);
    },
  });
}

export function usePauseSubscription(): UseMutationResult<SubscriptionView, Error, void> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: () => client.call(billingEndpoints.pauseSubscription),
    onSuccess: () => {
      invalidateSubscriptionAndCredits(queryClient, workspaceId);
    },
  });
}

/**
 * Caller-side gate for the two payment-rail queries. A build with no rail has
 * nothing to fetch and should not spend a request finding that out (F07-C2);
 * it composes with the workspace gate the same way `useSubscriptionStatusPolling`
 * already composes its own.
 */
export interface BillingQueryOptions {
  enabled?: boolean;
}

export function useMandates(options: BillingQueryOptions = {}): UseQueryResult<MandateView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.mandates(workspaceId ?? "none"),
    enabled: (options.enabled ?? true) && workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(billingEndpoints.mandates),
  });
}

export function useRevokeMandate(): UseMutationResult<MandateView, Error, string> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (mandateId: string) =>
      client.call(billingEndpoints.revokeMandate, { params: { mandateId } }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: billingQueryKeys.mandates(workspaceId) });
      invalidateSubscriptionAndCredits(queryClient, workspaceId);
    },
  });
}

export function usePaymentMethods(
  options: BillingQueryOptions = {},
): UseQueryResult<PaymentMethodView[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.paymentMethods(workspaceId ?? "none"),
    enabled: (options.enabled ?? true) && workspaceId !== null,
    retry: retryPolicy,
    queryFn: () => client.call(billingEndpoints.paymentMethods),
  });
}

/**
 * Poll `GET /billing/subscription` until the status the checkout sheet is
 * waiting on settles (or `enabled` is turned off). `refetchInterval` rather
 * than a bespoke timer: TanStack already owns "is this query mounted,
 * cancel on unmount" bookkeeping.
 */
export function useSubscriptionStatusPolling(
  enabled: boolean,
): UseQueryResult<SubscriptionView | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.subscription(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "active" || status === "cancelled" || status === "expired") return false;
      return 2_000;
    },
    queryFn: () => client.call(billingEndpoints.subscription),
  });
}

// --- Tax profile / workspace billing fields (A05) ---------------------------

export function useWorkspaceBilling(): UseQueryResult<WorkspaceBillingView> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.workspace(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () =>
      client.call(workspaceBillingEndpoints.get, { params: { id: workspaceId ?? "" } }),
  });
}

export function useSetTaxProfile(): UseMutationResult<
  WorkspaceBillingView,
  Error,
  TaxProfileRequest
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (body: TaxProfileRequest) =>
      client.call(workspaceBillingEndpoints.setTaxProfile, {
        params: { id: workspaceId ?? "" },
        body,
      }),
    onSuccess: (view) => {
      if (workspaceId === null) return;
      queryClient.setQueryData(billingQueryKeys.workspace(workspaceId), view);
    },
  });
}

// --- Credits and usage (B02) -------------------------------------------------

export function useCreditsSummary(): UseQueryResult<CreditsSummary> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.credits(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    staleTime: 30_000,
    retry: retryPolicy,
    queryFn: () =>
      client.call(workspaceBillingEndpoints.credits, { params: { id: workspaceId ?? "" } }),
  });
}

export function useUsagePage(cursor?: string): UseQueryResult<UsagePage> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: [...billingQueryKeys.usage(workspaceId ?? "none"), cursor ?? "first"] as const,
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: () =>
      client.call(workspaceBillingEndpoints.usage, {
        params: { id: workspaceId ?? "" },
        query: { cursor },
      }),
  });
}

// --- Invoices (B05, in flight) ------------------------------------------------

/**
 * `GET /invoices` (B05). Resolves to `[]` — not an error state — when the
 * route does not exist yet, so the Invoices page renders an honest empty
 * state instead of an error banner while B05 is still in flight (brief:
 * "keep it resilient to an empty endpoint").
 */
export function useInvoices(): UseQueryResult<InvoiceRow[]> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: billingQueryKeys.invoices(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    retry: retryPolicy,
    queryFn: async () => {
      try {
        return await client.call(invoiceEndpoints.list);
      } catch (error) {
        if (isRouteMissing(error)) return [];
        throw error;
      }
    },
  });
}

export function useInvoiceDownloadUrl(): UseMutationResult<InvoiceDownload, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (invoiceId: string) =>
      client.call(invoiceEndpoints.download, { params: { invoiceId } }),
  });
}
