import { AsyncLocalStorage } from "node:async_hooks";

import { ulid } from "ulid";

/**
 * Per-request state that every layer needs but nothing should have to thread
 * through its signatures: the request id that appears in the error envelope
 * (CONTRACTS §8), and — once A04 lands — the caller's identity.
 *
 * `workspaceId` comes from the JWT, never from a header: THREAT-MODEL T4 is tenant
 * confusion, and a header-supplied workspace is exactly how that happens.
 */
export interface RequestContextStore {
  readonly requestId: string;
  userId?: string;
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/** Header a caller (or an edge proxy) may set to join its own trace to ours. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Reject absurd or hostile inbound ids rather than logging them verbatim. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function newRequestId(): string {
  return ulid();
}

/** An inbound id if it is well-formed, otherwise a fresh one. */
export function normaliseRequestId(candidate: unknown): string {
  if (typeof candidate === "string" && VALID_REQUEST_ID.test(candidate)) return candidate;
  return newRequestId();
}

export const RequestContext = {
  /** Run `fn` with `store` bound for the whole async subtree. */
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /** The active store, or `undefined` outside a request (workers, boot, tests). */
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  /** The active request id, or `"unknown"` when called outside a request. */
  requestId(): string {
    return storage.getStore()?.requestId ?? "unknown";
  },

  /**
   * Attach the caller's identity once authentication has resolved it. A no-op
   * outside a request, so a background job calling shared code cannot crash.
   */
  setPrincipal(principal: { userId?: string; workspaceId?: string }): void {
    const store = storage.getStore();
    if (store === undefined) return;
    if (principal.userId !== undefined) store.userId = principal.userId;
    if (principal.workspaceId !== undefined) store.workspaceId = principal.workspaceId;
  },
};
