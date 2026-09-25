"use client";

import {
  ChevronDown,
  ChevronsUpDown,
  Globe,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
  User,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  useCurrentUser,
  useSession,
  useSwitchWorkspace,
  useUpdateMe,
  useWorkspaces,
} from "@montaj/api-client";
import type { TokenResponse } from "@montaj/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@montaj/ui";

import { resetAnalytics } from "@/lib/analytics/posthog";
import { messageForError } from "@/lib/errors";
import { useLocale, useT } from "@/lib/i18n/locale-provider";
import { endSession, persistSession } from "@/lib/session/client";

/**
 * The profile block at the bottom of the sidebar (08 §3).
 *
 * Three widths, one menu. `editor` is the studio's slim top bar; `compact` is
 * the canvas's 68 px rail, where only the avatar fits and the name has to come
 * from the tooltip-less accessible label instead; the default is the expanded
 * sidebar's avatar-name-caret row.
 */
export function ProfileMenu({
  onNavigate,
  editor = false,
  compact = false,
}: {
  onNavigate?: () => void;
  editor?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const session = useSession();
  const me = useCurrentUser();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const [locale, setLocale] = useLocale();
  const updateMe = useUpdateMe();
  const t = useT();

  /*
   * Switching workspace lives here, not only in the sidebar.
   *
   * The 68 px rail is the shell's default width and has no room for the
   * sidebar's switcher, and the sidebar's only other mount is a sheet whose
   * trigger is `lg:hidden` — so on a desktop in the default shell there was
   * no way to change workspace at all. This menu is in both shells.
   *
   * It is still a **token exchange**, never a header (CONTRACTS §5,
   * THREAT-MODEL T4): the API mints a new session bound to the new workspace
   * and re-checks membership while doing it.
   */
  const workspaces = useWorkspaces();
  const switchWorkspace = useSwitchWorkspace(
    React.useCallback(async (tokens: TokenResponse) => {
      await persistSession(tokens);
    }, []),
  );
  const options = workspaces.data ?? [];

  const name = me.data?.name ?? me.data?.email ?? "Your account";

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    // One same-origin call does both halves: the route handler reads the
    // httpOnly refresh cookie, asks the API to revoke the whole family, and
    // drops the cookie whatever the answer. It used to send `refreshToken: ""`
    // from here — which the API rejects as too short — and then clear only the
    // cookie, leaving the family live for 30 days (P0-06).
    const revoked = await endSession();
    if (!revoked) {
      // Signed out of this browser, but the session may still exist elsewhere.
      // Say so: silently implying a clean sign-out is how a stolen token keeps
      // working after the user believes they have stopped it.
      toast.warning("Signed out of this browser", {
        description:
          "We could not reach the server to end the session everywhere. " +
          "Check Settings → Sessions from another device.",
      });
    }
    resetAnalytics();
    router.replace("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon" : undefined}
          aria-label={compact ? name : undefined}
          className={
            compact
              ? "size-8 rounded-full p-0"
              : editor
                ? "editor-profile justify-start gap-2"
                : "w-full justify-start gap-2.5"
          }
          data-testid="profile-menu"
        >
          <span
            aria-hidden="true"
            className="bg-neutral-800 text-fg-0 flex size-7 shrink-0 items-center justify-center rounded-full text-2xs font-semibold"
          >
            {editor ? initials(name).slice(0, 1) : initials(name)}
          </span>
          {compact ? null : <span className="truncate text-sm">{name}</span>}
          {editor ? <ChevronDown className="size-3 text-fg-2" aria-hidden="true" /> : null}
          {compact || editor ? null : (
            <ChevronsUpDown className="text-fg-2 ml-auto size-3.5" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={editor ? "end" : "start"}
        side={editor ? "bottom" : compact ? "right" : "top"}
        className="w-64"
      >
        {/*
          Who is signed in, then in what capacity. This used to be the bare role
          ("owner") styled as an uppercase group label, which named nothing a
          person would recognise as themselves.
        */}
        <div className="flex flex-col gap-0.5 px-2.5 py-2" data-testid="profile-menu-identity">
          <span className="text-fg-0 truncate text-sm font-medium">{name}</span>
          {session?.role === undefined ? null : (
            <span className="text-fg-2 text-xs capitalize">{session.role}</span>
          )}
        </div>
        <DropdownMenuSeparator />
        {options.length < 2 ? null : (
          <>
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={session?.workspaceId ?? ""}
              onValueChange={(workspaceId) => {
                if (workspaceId === session?.workspaceId) return;
                switchWorkspace.mutate(workspaceId, {
                  onSuccess: () => {
                    router.refresh();
                  },
                  onError: (error) => {
                    toast.error("Could not switch workspace", {
                      description: messageForError(error),
                    });
                  },
                });
              }}
            >
              {options.map((workspace) => (
                <DropdownMenuRadioItem
                  key={workspace.id}
                  value={workspace.id}
                  data-testid={`profile-workspace-${workspace.id}`}
                >
                  <span className="truncate">{workspace.name}</span>
                  <span className="text-fg-2 ml-auto text-2xs capitalize">{workspace.role}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild>
          <Link href="/settings/profile" onClick={onNavigate}>
            <User aria-hidden="true" />
            Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/privacy" onClick={onNavigate}>
            <ShieldCheck aria-hidden="true" />
            Privacy
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/devices" onClick={onNavigate}>
            <MonitorSmartphone aria-hidden="true" />
            Devices & sessions
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            const next = locale === "hi" ? "en" : "hi";
            setLocale(next);
            const bcp47 = next === "hi" ? "hi-IN" : "en-IN";
            updateMe.mutate({ locale: bcp47 });
          }}
          data-testid="locale-switch"
        >
          <Globe aria-hidden="true" />
          {t("profile.language")}:{" "}
          {locale === "hi" ? t("profile.language.hi") : t("profile.language.en")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
          data-testid="sign-out"
        >
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Two letters at most: an avatar placeholder, never the whole address. */
export function initials(value: string): string {
  const local = value.split("@")[0] ?? value;
  const parts = local.split(/[\s._-]+/).filter((part) => part !== "");
  const letters = parts.slice(0, 2).map((part) => part[0] ?? "");
  return (letters.join("") || local.slice(0, 2)).toUpperCase();
}
