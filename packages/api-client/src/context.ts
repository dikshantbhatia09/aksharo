"use client";

/**
 * The React context every hook reads from.
 *
 * Built with `createElement` rather than JSX so this package stays a plain
 * TypeScript build with no JSX pipeline of its own; `apps/web` marks its own
 * provider file `"use client"` and mounts `ApiProvider` inside it.
 */

import { createContext, createElement, useContext, useSyncExternalStore } from "react";

import type { ApiClient } from "./http.js";
import type { SessionSnapshot, SessionStore } from "./session.js";
import type { ReactNode } from "react";

export interface ApiContextValue {
  client: ApiClient;
  session: SessionStore;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider(props: {
  value: ApiContextValue;
  children: ReactNode;
}): ReturnType<typeof createElement> {
  return createElement(ApiContext.Provider, { value: props.value }, props.children);
}

export function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (value === null) {
    throw new Error("useApiContext must be used inside <ApiProvider>.");
  }
  return value;
}

export function useApiClient(): ApiClient {
  return useApiContext().client;
}

/**
 * The current session claims, re-rendering when the store changes.
 *
 * `useSyncExternalStore` rather than a `useState` mirror: the store is written
 * from outside React (the refresh that a 401 triggers), and a mirror would
 * happily render a workspace the token no longer names.
 */
export function useSession(): SessionSnapshot | null {
  const { session } = useApiContext();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, () => null);
}

/** The active workspace id, or `null` when signed out. */
export function useWorkspaceId(): string | null {
  return useSession()?.workspaceId ?? null;
}
