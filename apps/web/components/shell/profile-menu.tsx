"use client";

import { Globe, LogOut, Settings, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  endpoints,
  useApiClient,
  useCurrentUser,
  useSession,
  useUpdateMe,
} from "@montaj/api-client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@montaj/ui";

import { resetAnalytics } from "@/lib/analytics/posthog";
import { useLocale, useT } from "@/lib/i18n/locale-provider";
import { clearSession } from "@/lib/session/client";

/** The profile block at the bottom of the sidebar (08 §3). */
export function ProfileMenu({ onNavigate }: { onNavigate?: () => void }): React.JSX.Element {
  const session = useSession();
  const me = useCurrentUser();
  const client = useApiClient();
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);
  const [locale, setLocale] = useLocale();
  const updateMe = useUpdateMe();
  const t = useT();

  const name = me.data?.name ?? me.data?.email ?? "Your account";

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    // The API revokes the family; the route handler drops the cookie. The cookie
    // goes even if the API call fails, because a token the server no longer
    // honours is worse than none.
    await client.call(endpoints.auth.logout, { body: { refreshToken: "" } }).catch(() => undefined);
    await clearSession();
    resetAnalytics();
    router.replace("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="mx-1 justify-start gap-2.5" data-testid="profile-menu">
          <span
            aria-hidden="true"
            className="bg-bg-2 text-fg-1 flex size-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold"
          >
            {initials(name)}
          </span>
          <span className="truncate text-sm">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
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
