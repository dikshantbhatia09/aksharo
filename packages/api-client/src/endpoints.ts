/**
 * Every route the web shell calls, as typed endpoint descriptors.
 *
 * Routes carrying an `operationId` are in the generated index and are checked
 * against it by `contract.test.ts`. Routes carrying `pending` are specified in
 * `07-api-and-contracts.md` but their work package has not landed; the client
 * raises `client/not_implemented` for them, and the same contract test asserts
 * they are still absent — so the day the owning work package merges, this file
 * fails a test and gets updated rather than silently continuing to guess. That
 * is not hypothetical: A05 landed between A13's first commit and its merge, and
 * this is how the seven routes below moved.
 */

import { defineEndpoint } from "./http.js";

import type {
  ConsentState,
  CurrentUser,
  DeviceApproveRequest,
  Entitlement,
  LoginRequest,
  MagicLinkResponse,
  MemoryEntry,
  OAuthCompleteRequest,
  PendingApproval,
  RightsRequest,
  SessionSummary,
  SetConsentRequest,
  SignUpRequest,
  SignUpResponse,
  TokenResponse,
  UpdateMeRequest,
  UsageSummary,
  WorkspaceSummary,
} from "./types.js";

/** Auth (A04). */
export const authEndpoints = {
  signUp: defineEndpoint<SignUpRequest, SignUpResponse>({
    method: "POST",
    path: "/auth/signup",
    auth: "public",
    operationId: "AuthController_signUp",
  }),
  login: defineEndpoint<LoginRequest, TokenResponse>({
    method: "POST",
    path: "/auth/login",
    auth: "public",
    operationId: "AuthController_login",
  }),
  verifyEmail: defineEndpoint<{ token: string }, { verified: true }>({
    method: "POST",
    path: "/auth/verify-email",
    auth: "public",
    operationId: "AuthController_verifyEmail",
  }),
  requestMagicLink: defineEndpoint<{ email: string }, MagicLinkResponse>({
    method: "POST",
    path: "/auth/magic-link",
    auth: "public",
    operationId: "AuthController_requestMagicLink",
  }),
  consumeMagicLink: defineEndpoint<{ token: string; kind?: string }, TokenResponse>({
    method: "POST",
    path: "/auth/magic-link/consume",
    auth: "public",
    operationId: "AuthController_consumeMagicLink",
  }),
  refresh: defineEndpoint<{ refreshToken: string }, TokenResponse>({
    method: "POST",
    path: "/auth/refresh",
    auth: "public",
    operationId: "AuthController_refresh",
  }),
  logout: defineEndpoint<{ refreshToken: string }, void>({
    method: "POST",
    path: "/auth/logout",
    auth: "public",
    operationId: "AuthController_logout",
  }),
  exchangeWorkspace: defineEndpoint<{ workspaceId: string }, TokenResponse>({
    method: "POST",
    path: "/auth/token/exchange",
    auth: "bearer",
    operationId: "AuthController_exchange",
  }),
  listSessions: defineEndpoint<void, SessionSummary[]>({
    method: "GET",
    path: "/auth/sessions",
    auth: "bearer",
    operationId: "AuthController_listSessions",
  }),
  revokeSession: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/auth/sessions/{sessionId}",
    auth: "bearer",
    operationId: "AuthController_revokeSession",
  }),
  parentalWaitlist: defineEndpoint<{ email: string }, { status: string }>({
    method: "POST",
    path: "/auth/parental-waitlist",
    auth: "public",
    operationId: "AuthController_joinWaitlist",
  }),
  completeOAuth: defineEndpoint<OAuthCompleteRequest, TokenResponse>({
    method: "POST",
    path: "/auth/oauth/complete",
    auth: "public",
    operationId: "OAuthController_complete",
  }),
} as const;

/** Device grant (A04) — RFC 8628, approved from an authenticated web session. */
export const deviceEndpoints = {
  describe: defineEndpoint<void, PendingApproval>({
    method: "GET",
    path: "/auth/device/code/{userCode}",
    auth: "bearer",
    operationId: "DeviceController_describe",
  }),
  decide: defineEndpoint<DeviceApproveRequest, { status: "approved" | "denied" }>({
    method: "POST",
    path: "/auth/device/approve",
    auth: "bearer",
    operationId: "DeviceController_decide",
  }),
} as const;

/** The account, its workspaces and its rights (A05). */
export const accountEndpoints = {
  me: defineEndpoint<void, CurrentUser>({
    method: "GET",
    path: "/me",
    auth: "bearer",
    operationId: "getMe",
  }),
  updateMe: defineEndpoint<UpdateMeRequest, CurrentUser>({
    method: "PATCH",
    path: "/me",
    auth: "bearer",
    operationId: "updateMe",
  }),
  listWorkspaces: defineEndpoint<void, WorkspaceSummary[]>({
    method: "GET",
    path: "/workspaces",
    auth: "bearer",
    operationId: "listWorkspaces",
  }),
  entitlement: defineEndpoint<void, Entitlement>({
    method: "GET",
    path: "/workspaces/{id}/entitlement",
    auth: "bearer",
    operationId: "getWorkspaceEntitlement",
  }),
  listConsents: defineEndpoint<void, ConsentState>({
    method: "GET",
    path: "/consents",
    auth: "bearer",
    operationId: "getConsents",
  }),
  /** One purpose per call: a consent record is per purpose (D60). */
  setConsent: defineEndpoint<SetConsentRequest, ConsentState>({
    method: "POST",
    path: "/consents",
    auth: "bearer",
    operationId: "setConsent",
  }),
  exportData: defineEndpoint<void, RightsRequest>({
    method: "GET",
    path: "/me/data",
    auth: "bearer",
    operationId: "requestMyData",
  }),
  deleteAccount: defineEndpoint<void, RightsRequest>({
    method: "DELETE",
    path: "/me",
    auth: "bearer",
    operationId: "deleteMe",
  }),
} as const;

/** Jobs (A08) — the shell needs them for `JobProgress` and the realtime resync. */
export const jobEndpoints = {
  get: defineEndpoint<void, { id: string; status: string; progress?: number; etaMs?: number }>({
    method: "GET",
    path: "/jobs/{id}",
    auth: "bearer",
    operationId: "getJob",
  }),
  list: defineEndpoint<void, { items: { id: string; status: string; type: string }[] }>({
    method: "GET",
    path: "/jobs",
    auth: "bearer",
    operationId: "listJobs",
  }),
} as const;

/**
 * Routes `07-api-and-contracts.md` specifies whose work package has not landed.
 *
 * `/usage` carries the credit balance and the burn rate, which belong to the
 * ledger (B02); `/memory` is the learned-memory store of D62 (B09). Until they
 * exist the meter shows the plan's allowance and the memory screen says so.
 */
export const pendingEndpoints = {
  usage: defineEndpoint<void, UsageSummary>({
    method: "GET",
    path: "/usage",
    auth: "bearer",
    pending: "B02",
  }),
  listMemory: defineEndpoint<void, MemoryEntry[]>({
    method: "GET",
    path: "/memory",
    auth: "bearer",
    pending: "B09",
  }),
  clearMemory: defineEndpoint<void, void>({
    method: "DELETE",
    path: "/memory",
    auth: "bearer",
    pending: "B09",
  }),
} as const;

export const endpoints = {
  auth: authEndpoints,
  device: deviceEndpoints,
  account: accountEndpoints,
  jobs: jobEndpoints,
  pending: pendingEndpoints,
} as const;

/** Flat list, for the contract test. */
export const ALL_ENDPOINTS = [
  ...Object.entries(authEndpoints),
  ...Object.entries(deviceEndpoints),
  ...Object.entries(accountEndpoints),
  ...Object.entries(jobEndpoints),
  ...Object.entries(pendingEndpoints),
] as const;
