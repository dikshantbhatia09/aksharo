"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import {
  endpoints,
  RealtimeClient,
  rooms,
  useApiContext,
  useProjects,
  useSession,
} from "@montaj/api-client";
import type { RealtimeEvent } from "@montaj/api-client";
import { toast } from "@montaj/ui";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

import { WhatsNewModal } from "@/components/academy/whats-new-modal";
import { useRuntimeConfig } from "@/components/providers";
import { ReferralPromptSheet } from "@/components/referrals/referral-prompt-sheet";
import { announceTranscriptReady } from "@/lib/edg/transcription-state";
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
  const pathname = usePathname();
  // The studio editor (`/p/[id]`) is its own full-bleed 4-zone layout
  // (design/00 §2) with no room for the 16rem dashboard sidebar or the
  // dashboard's search/New-project/Aura top bar — it renders its own slim
  // top bar (`EditorTopBar`) instead. Every other route keeps the shell.
  const isEditorRoute = pathname?.startsWith("/p/") === true;
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
  const { client: apiClient, session: sessionStore } = useApiContext();

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

        // REP-006: a repurposing run's stage moved. Emitted on the WORKSPACE room
        // because a run outlives any one project, and invalidated as a pointer
        // rather than merged: the payload carries enough to render, but the run
        // projection is the server's to own, and a refetch cannot disagree with it.
        if (event.event === "repurpose.stage.changed") {
          void queryClient.invalidateQueries({
            queryKey: ["ws", session.workspaceId, "repurpose"],
          });
        }

        // FIX-03: a finished transcription is the one completion that changes
        // which screen the user should be on, so it gets its own narrow branch.
        //
        // The payload is `{jobId, status, type?, error?}` and carries NO
        // `projectId` (`realtime.protocol.ts` → `JobCompletedEvent`), and this
        // shell is subscribed to the *workspace* room, so `event.room` is
        // `workspace:{id}` and cannot supply one either. The job is therefore
        // read back for it — one GET per transcription completion, not per user.
        if (event.event === "job.completed") {
          const data = event.data as {
            jobId?: string;
            status?: string;
            type?: string;
            error?: { message?: string };
          };
          const jobId = data.jobId;
          // FIX-04: transliteration finishing changes the words the editor is
          // rendering too (the new script lands on `word.scripts`), and the
          // announcement path is identical — the editor reload refetches the
          // chunks that carry them. S-03 adds the third: an import's alignment
          // completion is what initialises the editing document for a project
          // that never ran a transcription at all. Every string is a queue name
          // declared in `apps/api/src/jobs/contracts/queue-names.ts` (lines 17,
          // 21 and 18).
          const announceable = [
            "ai.transcribe",
            "ai.transliterate",
            "ai.align", // S-03: imported subtitles arrive via ai.align
          ].includes(data.type ?? "");

          if (announceable && data.status === "succeeded" && jobId !== undefined) {
            void (async () => {
              let projectId: string | null = null;
              try {
                projectId = (await apiClient.call(endpoints.jobs.get, { params: { id: jobId } }))
                  .projectId;
              } catch {
                // The read model is the fallback: a waiting screen polls itself
                // to `ready` anyway. Never let a courtesy channel throw.
                return;
              }
              if (projectId === null) return;

              announceTranscriptReady(projectId);
              void queryClient.invalidateQueries({
                queryKey: ["ws", session.workspaceId, "projects"],
              });

              // Already on the project: the editor reloads itself off the event
              // above, and a toast over it would be noise.
              if (!window.location.pathname.startsWith(`/p/${projectId}`)) {
                const target = projectId;
                const transliterated = data.type === "ai.transliterate";
                // S-03: an alignment finishing means an *import* landed, and
                // announcing that as "Transcript ready" would credit work the
                // user deliberately did not pay for. Same screen change, its
                // own sentence.
                const imported = data.type === "ai.align";
                toast.success(
                  imported
                    ? "Captions imported"
                    : transliterated
                      ? "Script ready"
                      : "Transcript ready",
                  {
                    description: imported
                      ? "Your subtitles are aligned to the audio — open the editor."
                      : transliterated
                        ? "The new script is on the transcript — open the editor."
                        : "Captions are built — open the editor.",
                    action: {
                      label: "Open editor",
                      onClick: () => {
                        router.push(`/p/${target}`);
                      },
                    },
                  },
                );
              }
            })();
          } else if (announceable && data.status === "failed" && jobId !== undefined) {
            // S-06: the other half of the same story. A failed transcription or
            // import used to be silent unless the user happened to be sitting on
            // the waiting screen — the job row said `failed`, the card said
            // nothing, and nobody was told. An `else if` on `data.status`, never
            // a second `if`: one completion must never raise two toasts.
            void (async () => {
              let projectId: string | null = null;
              try {
                projectId = (await apiClient.call(endpoints.jobs.get, { params: { id: jobId } }))
                  .projectId;
              } catch {
                // Same courtesy-channel rule as the success path: never throw.
                return;
              }
              if (projectId === null) return;

              // A failed row changes the card's label too.
              void queryClient.invalidateQueries({
                queryKey: ["ws", session.workspaceId, "projects"],
              });

              // Already on the project: the waiting screen renders the failure
              // itself (S06-3), and a toast over it would be noise.
              if (window.location.pathname.startsWith(`/p/${projectId}`)) return;

              const target = projectId;
              toast.error(
                data.type === "ai.align" ? "Captions import failed" : "Transcription failed",
                {
                  description: data.error?.message ?? "Open the project to retry.",
                  action: {
                    label: "Open project",
                    onClick: () => {
                      router.push(`/p/${target}`);
                    },
                  },
                },
              );
            })();
          }
        }
      },
    });

    client.subscribe(rooms.workspace(session.workspaceId));
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [
    apiClient,
    bootstrapped,
    config.apiOrigin,
    queryClient,
    realtimeEnabled,
    router,
    session,
    sessionStore,
  ]);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {isEditorRoute ? (
        <main id="main" tabIndex={-1} className="h-dvh focus:outline-none">
          {children}
        </main>
      ) : (
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
      )}

      <CommandPalette open={open} onOpenChange={setOpen} recentProjects={recentProjects} />

      {/* B07b: the give-get sheet is a global growth prompt, not scoped to one
          screen — see `components/referrals/README.md`'s "Mount points". Waits
          for `bootstrapped` the same way the realtime connection above does,
          so it never queries `/referrals/me` before there is an access token. */}
      {bootstrapped && session !== null ? <ReferralPromptSheet /> : null}

      {/* B12: the What's-new modal, same "global, not scoped to one screen"
          shape as the give-get sheet above — see `components/academy/
          whats-new-modal.tsx`'s "Mount point". */}
      {bootstrapped && session !== null ? (
        <WhatsNewModal hasProjects={(recentProjectsQuery.data?.pages[0]?.items.length ?? 0) > 0} />
      ) : null}
    </div>
  );
}
