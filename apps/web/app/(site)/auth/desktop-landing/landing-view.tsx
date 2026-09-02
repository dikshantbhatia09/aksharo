"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import * as React from "react";

import { BRAND } from "@montaj/config";
import { Button } from "@montaj/ui";

import { AuthCard } from "@/components/auth/auth-card";

/**
 * The https page that hands a desktop sign-in back to the app.
 *
 * Adobe UXP and several desktop shells refuse to follow a custom scheme in a
 * top-level redirect from a third-party origin, but will follow one from a page
 * the user is already looking at — so the deep link is triggered from here, with
 * a visible button as the fallback when the automatic attempt is blocked.
 *
 * The API serves an equivalent page at `{API_ORIGIN}/auth/desktop-landing`
 * (A04), which is where the OAuth callback actually points today. This route is
 * the branded version on the web origin, for links the desktop app builds itself
 * and for anyone who lands here by hand.
 */
export function DesktopLandingView(): React.JSX.Element {
  const params = useSearchParams();
  // Only the characters a handoff code can contain, so nothing else reaches an
  // href the browser is about to navigate to.
  const code = (params.get("code") ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const status = params.get("status") === "registration" ? "registration" : "login";
  const [triggered, setTriggered] = React.useState(false);

  const deepLink =
    code === ""
      ? null
      : `${BRAND.deepLinkScheme}://auth-callback?code=${encodeURIComponent(code)}&status=${status}`;

  React.useEffect(() => {
    if (deepLink === null || triggered) return;
    setTriggered(true);
    window.location.assign(deepLink);
  }, [deepLink, triggered]);

  if (deepLink === null) {
    return (
      <AuthCard title="Something went wrong">
        <p className="text-fg-2 text-sm" data-testid="landing-error">
          This sign-in link is incomplete. Start again from the app.
        </p>
        <Button variant="secondary" asChild>
          <Link href="/login">Sign in on the web instead</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={`Return to ${BRAND.name}`}
      subtitle="Opening the app. If nothing happens, use the button below."
    >
      <Button variant="primary" size="lg" asChild data-testid="open-desktop-app">
        <a href={deepLink}>Open {BRAND.name}</a>
      </Button>
      <p className="text-fg-2 text-xs">
        Nothing opened? Make sure the desktop app is installed and running, then try again. You can
        also{" "}
        <Link href="/login" className="text-lime-500 rounded-sm hover:underline">
          carry on in the browser
        </Link>
        .
      </p>
    </AuthCard>
  );
}
