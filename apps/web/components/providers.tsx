"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { ApiProvider, createApiClient, SessionStore } from "@montaj/api-client";
import type { ApiContextValue } from "@montaj/api-client";
import { Toaster, TooltipProvider } from "@montaj/ui";

import type { RuntimeConfig } from "@/lib/runtime-config";

import {
  configureAnalytics,
  initAnalyticsIfConsented,
  resetAnalytics,
} from "@/lib/analytics/posthog";
import { initObservability } from "@/lib/observability/sentry";
import { clearSession, refreshSession } from "@/lib/session/client";

/**
 * Everything the client half of the app needs, mounted once at the root.
 *
 * The order matters: the session store is created before the API client because
 * the client reads tokens out of it, and the API client is created before the
 * query client so a refresh triggered by a query has somewhere to go.
 */

const RuntimeConfigContext = React.createContext<RuntimeConfig | null>(null);

/**
 * Provide a runtime config on its own, without the query client, the API client
 * or the analytics side effects. The test harness mounts shell components this
 * way; nothing in the app uses it.
 */
export function RuntimeConfigTestProvider({
  value,
  children,
}: {
  value: RuntimeConfig;
  children: React.ReactNode;
}): React.JSX.Element {
  return <RuntimeConfigContext.Provider value={value}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const value = React.useContext(RuntimeConfigContext);
  if (value === null) throw new Error("useRuntimeConfig must be used inside <Providers>.");
  return value;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The shell reads small, cheap things (entitlement, sessions). Refetching
        // them on every window focus is noise, and the realtime channel already
        // tells us when something changed.
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: 1,
      },
    },
  });
}

export function Providers({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const [queryClient] = React.useState(makeQueryClient);

  const api = React.useMemo<ApiContextValue>(() => {
    const session = new SessionStore();
    const client = createApiClient({
      baseUrl: config.apiOrigin,
      getAccessToken: session.getAccessToken,
      refreshAccessToken: async () => {
        const refreshed = await refreshSession();
        if (refreshed === null) {
          session.clear();
          return null;
        }
        session.set(refreshed.accessToken);
        return refreshed.accessToken;
      },
      onUnauthenticated: () => {
        session.clear();
        void clearSession();
        resetAnalytics();
        queryClient.clear();
        router.replace("/login?reason=expired");
      },
    });
    return { client, session };
  }, [config.apiOrigin, queryClient, router]);

  /*
   * Mark the document hydrated.
   *
   * Until React has hydrated, a controlled input is only server-rendered HTML:
   * anything typed into it is discarded the moment hydration replaces the value
   * with component state. That is invisible to a person (they cannot type that
   * fast) and lethal to a test runner (it can). The attribute gives the suite
   * something honest to wait for, and it is a useful thing to see in devtools.
   */
  React.useEffect(() => {
    document.documentElement.dataset["hydrated"] = "true";
  }, []);

  React.useEffect(() => {
    configureAnalytics({ key: config.posthogKey, host: config.posthogHost });
    initAnalyticsIfConsented();
    initObservability(config.sentryDsn, config.environment);
  }, [config.posthogKey, config.posthogHost, config.sentryDsn, config.environment]);

  return (
    <RuntimeConfigContext.Provider value={config}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider value={api}>
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster />
          </TooltipProvider>
        </ApiProvider>
      </QueryClientProvider>
    </RuntimeConfigContext.Provider>
  );
}
