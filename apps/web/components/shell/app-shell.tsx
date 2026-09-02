"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { RealtimeClient, rooms, useApiContext, useSession } from "@montaj/api-client";
import type { RealtimeEvent } from "@montaj/api-client";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

import { useRuntimeConfig } from "@/components/providers";
import { refreshSession } from "@/lib/session/client";

/**
 * The authenticated frame: sidebar, top bar, command palette, realtime.
 *
 * The session itself is enforced twice on purpose. `middleware.ts` redirects a
 * request with no cookie before any HTML is sent, which is what makes the first
 * paint correct; this component then bootstraps an access token and, if it
 * cannot, sends the user to `/login`. The middleware alone is not enough — a
 * cookie can exist for a family the API has revoked — and this alone is not
 * enough either, because it would flash the shell first.
 */
export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const config = useRuntimeConfig();
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { open, setOpen } = useCommandPalette();
  const [bootstrapped, setBootstrapped] = React.useState(false);

  // The store object itself, not a subscription: `useSession()` above already
  // re-renders on a token change, and subscribing here as well would restart the
  // WebSocket on every rotation.
  const { session: sessionStore } = useApiContext();

  // One rotation on mount turns the httpOnly cookie into an in-memory access
  // token. Everything else in the shell waits for it.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (sessionStore.getAccessToken() !== null) {
        setBootstrapped(true);
        return;
      }
      const refreshed = await refreshSession();
      if (cancelled) return;
      if (refreshed === null) {
        router.replace("/login?reason=expired");
        return;
      }
      sessionStore.set(refreshed.accessToken);
      setBootstrapped(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [router, sessionStore]);

  // Realtime is a courtesy channel: on every (re)connect the shell invalidates
  // what the events would have changed, so a client that was offline converges
  // by re-reading rather than by replaying (realtime/README §Reconnection).
  /*
   * The realtime channel is behind a flag until A08's Redis fan-out is fixed.
   *
   * `RedisRealtimeBus` duplicates a connection created with `lazyConnect: true`
   * and `enableOfflineQueue: false`, so the duplicate is never dialled and the
   * first `SUBSCRIBE` rejects with "Stream isn't writeable" — which takes the
   * whole API process down. A08's own suite only exercises the in-memory bus, so
   * nothing caught it before a browser actually joined a room. Set
   * `FEATURE_FLAGS_JSON={"realtime.enabled":true}` once that is fixed; the client
   * itself is complete and covered by `packages/api-client` tests.
   */
  const realtimeEnabled = config.flags["realtime.enabled"] === true;

  React.useEffect(() => {
    if (!bootstrapped || session === null || !realtimeEnabled) return;

    const client = new RealtimeClient({
      url: `${config.apiOrigin.replace(/^http/, "ws")}/realtime`,
      getAccessToken: sessionStore.getAccessToken,
      refreshAccessToken: async () => {
        const refreshed = await refreshSession();
        if (refreshed === null) return null;
        sessionStore.set(refreshed.accessToken);
        return refreshed.accessToken;
      },
      onResync: () => {
        void queryClient.invalidateQueries();
      },
      onEvent: (event: RealtimeEvent) => {
        if (event.event === "job.completed" || event.event === "job.progress") {
          void queryClient.invalidateQueries({ queryKey: ["ws", session.workspaceId, "jobs"] });
        }
      },
    });

    client.subscribe(rooms.workspace(session.workspaceId));
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [bootstrapped, config.apiOrigin, queryClient, realtimeEnabled, session, sessionStore]);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <div className="lg:grid lg:grid-cols-[16rem_1fr]">
        <aside
          className="border-border bg-bg-1 sticky top-0 hidden h-dvh border-r lg:block"
          data-testid="sidebar"
        >
          <Sidebar />
        </aside>

        <div className="flex min-h-dvh min-w-0 flex-col">
          <TopBar
            onOpenPalette={() => {
              setOpen(true);
            }}
          />
          <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 focus:outline-none sm:px-6">
            {children}
          </main>
        </div>
      </div>

      <CommandPalette open={open} onOpenChange={setOpen} />
    </div>
  );
}
