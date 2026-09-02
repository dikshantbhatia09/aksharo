"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";

import { RealtimeClient, rooms, useApiContext, useProjects, useSession } from "@montaj/api-client";
import type { RealtimeEvent } from "@montaj/api-client";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

import { WhatsNewModal } from "@/components/academy/whats-new-modal";
import { useRuntimeConfig } from "@/components/providers";
import { ReferralPromptSheet } from "@/components/referrals/referral-prompt-sheet";
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

  // The palette's "Recent projects" group (A14): only the first page, and only
  // once the palette might actually open — there is no reason to hold a
  // project list query alive on every screen in the shell.
  const recentProjectsQuery = useProjects({ limit: 8 });
  const recentProjects = React.useMemo(
    () =>
      (recentProjectsQuery.data?.pages[0]?.items ?? []).map((project) => ({
        id: project.id,
        title: project.title,
        href: `/p/${project.id}`,
      })),
    [recentProjectsQuery.data],
  );

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
   * The realtime channel, with a kill switch.
   *
   * A13 originally shipped this off: joining a room took the API process down,
   * because `RedisRealtimeBus` duplicated a connection created with
   * `lazyConnect: true` and `enableOfflineQueue: false`, so the duplicate was
   * never dialled and the first `SUBSCRIBE` was rejected outright. A08c fixed
   * that — the bus now connects before it subscribes and the gateway refuses a
   * room rather than letting the rejection escape — so the channel is on, and
   * `FEATURE_FLAGS_JSON={"realtime.enabled":false}` turns it off again without a
   * rebuild if a deployment ever needs that.
   */
  const realtimeEnabled = config.flags["realtime.enabled"] !== false;

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

      <CommandPalette open={open} onOpenChange={setOpen} recentProjects={recentProjects} />

      {/* B07b: the give-get sheet is a global growth prompt, not scoped to one
          screen — see `components/referrals/README.md`'s "Mount points". Waits
          for `bootstrapped` the same way the realtime connection above does,
          so it never queries `/referrals/me` before there is an access token. */}
      {bootstrapped && session !== null ? <ReferralPromptSheet /> : null}

      {/* B12: the What's-new modal, same "global, not scoped to one screen"
          shape as the give-get sheet above — see `components/academy/
          whats-new-modal.tsx`'s "Mount point". */}
      {bootstrapped && session !== null ? <WhatsNewModal /> : null}
    </div>
  );
}
