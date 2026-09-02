/**
 * Typed endpoint descriptors for `/billing/*`, the tax profile, credits/usage and
 * invoices — the same `defineEndpoint` shape `packages/api-client/src/endpoints.ts`
 * uses, kept local to `apps/web` (see `types.ts`'s header comment for why).
 *
 * `defineEndpoint`'s `operationId` is optional; every id below is copied from the
 * live OpenAPI document (`packages/api-client/openapi.json`) purely for
 * documentation and to make a future move into `packages/api-client` a paste, not a
 * rewrite — nothing here is checked against it (that check, `contract.test.ts`,
 * lives in the package this file deliberately does not touch).
 */

import { defineEndpoint } from "@montaj/api-client";

import type {
  ChangePreview,
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

export const billingEndpoints = {
  plans: defineEndpoint<void, PlanView[]>({
    method: "GET",
    path: "/billing/plans",
    auth: "public",
    operationId: "listPlans",
  }),
  checkout: defineEndpoint<CheckoutRequest, CheckoutResponse>({
    method: "POST",
    path: "/billing/checkout",
    auth: "bearer",
    operationId: "createCheckout",
  }),
  passCheckout: defineEndpoint<
    { readonly kind: "first_export" | "week_pass" | "pay_once"; readonly planKey?: string },
    PassCheckoutResponse
  >({
    method: "POST",
    path: "/billing/passes/checkout",
    auth: "bearer",
    operationId: "createPassCheckout",
  }),
  topupCheckout: defineEndpoint<{ readonly credits: number }, PassCheckoutResponse>({
    method: "POST",
    path: "/billing/topups/checkout",
    auth: "bearer",
    operationId: "createTopupCheckout",
  }),
  subscription: defineEndpoint<void, SubscriptionView | null>({
    method: "GET",
    path: "/billing/subscription",
    auth: "bearer",
    operationId: "getSubscription",
  }),
  cancelSubscription: defineEndpoint<void, SubscriptionView>({
    method: "POST",
    path: "/billing/subscription/cancel",
    auth: "bearer",
    operationId: "cancelSubscription",
  }),
  resumeSubscription: defineEndpoint<void, SubscriptionView>({
    method: "POST",
    path: "/billing/subscription/resume",
    auth: "bearer",
    operationId: "resumeSubscription",
  }),
  pauseSubscription: defineEndpoint<void, SubscriptionView>({
    method: "POST",
    path: "/billing/subscription/pause",
    auth: "bearer",
    operationId: "pauseSubscription",
  }),
  changePreview: defineEndpoint<void, ChangePreview>({
    method: "GET",
    path: "/billing/subscription/change-preview",
    auth: "bearer",
    operationId: "previewChangePlan",
  }),
  changePlan: defineEndpoint<CheckoutRequest, SubscriptionView | CheckoutResponse>({
    method: "POST",
    path: "/billing/subscription/change-plan",
    auth: "bearer",
    operationId: "changePlan",
  }),
  mandates: defineEndpoint<void, MandateView[]>({
    method: "GET",
    path: "/billing/mandates",
    auth: "bearer",
    operationId: "listMandates",
  }),
  revokeMandate: defineEndpoint<void, MandateView>({
    method: "POST",
    path: "/billing/mandates/{mandateId}/revoke",
    auth: "bearer",
    operationId: "revokeMandate",
  }),
  paymentMethods: defineEndpoint<void, PaymentMethodView[]>({
    method: "GET",
    path: "/billing/payment-methods",
    auth: "bearer",
    operationId: "listPaymentMethods",
  }),
} as const;

export const workspaceBillingEndpoints = {
  get: defineEndpoint<void, WorkspaceBillingView>({
    method: "GET",
    path: "/workspaces/{id}",
    auth: "bearer",
    operationId: "getWorkspace",
  }),
  setTaxProfile: defineEndpoint<TaxProfileRequest, WorkspaceBillingView>({
    method: "PUT",
    path: "/workspaces/{id}/tax-profile",
    auth: "bearer",
    operationId: "setWorkspaceTaxProfile",
  }),
  credits: defineEndpoint<void, CreditsSummary>({
    method: "GET",
    path: "/workspaces/{id}/credits",
    auth: "bearer",
    operationId: "getWorkspaceCredits",
  }),
  usage: defineEndpoint<void, UsagePage>({
    method: "GET",
    path: "/workspaces/{id}/usage",
    auth: "bearer",
    operationId: "getWorkspaceUsage",
  }),
} as const;

/**
 * `GET /invoices` and `GET /invoices/{invoiceId}/download` (B05, in flight — not on
 * `main` at the time this work package branched). Calling either against an API
 * build that predates B05 answers `common/not_found`; `hooks.ts`'s `useInvoices`
 * treats that as "no invoices yet" rather than an error (brief: "keep it resilient
 * to an empty endpoint").
 */
export const invoiceEndpoints = {
  list: defineEndpoint<void, InvoiceRow[]>({
    method: "GET",
    path: "/invoices",
    auth: "bearer",
  }),
  download: defineEndpoint<void, InvoiceDownload>({
    method: "GET",
    path: "/invoices/{invoiceId}/download",
    auth: "bearer",
  }),
} as const;
