"use client";

import { ChevronDown, Globe, LogOut, Settings, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useCurrentUser, useSession, useUpdateMe } from "@montaj/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@montaj/ui";

import { resetAnalytics } from "@/lib/analytics/posthog";
import { useLocale, useT } from "@/lib/i18n/locale-provider";
import { endSession } from "@/lib/session/client";

/** The profile block at the bottom of the sidebar (08 §3). */
export function ProfileMenu({
  onNavigate,
  editor = false,
}: {
  onNavigate?: () => void;
  editor?: boolean;
}): React.JSX.Element {
  const session = useSession();
  const me = useCurrentUser();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const [locale, setLocale] = useLocale();
  const updateMe = useUpdateMe();
  const t = useT();

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
          className={editor ? "editor-profile justify-start gap-2" : "mx-1 justify-start gap-2.5"}
          data-testid="profile-menu"
        >
          <span
            aria-hidden="true"
            className="bg-bg-2 text-fg-1 flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold"
          >
            {editor ? initials(name).slice(0, 1) : initials(name)}
          </span>
          <span className="truncate text-sm">{name}</span>
          {editor ? <ChevronDown className="size-3 text-fg-2" aria-hidden="true" /> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={editor ? "end" : "start"}
        side={editor ? "bottom" : "top"}
        className="w-64"
      >
        <DropdownMenuLabel>{session?.role ?? "Account"}</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
            <Settings aria-hidden="true" />
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
