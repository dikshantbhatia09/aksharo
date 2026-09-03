"use client";

import * as React from "react";

import { Button } from "@montaj/ui";

import { useRuntimeConfig } from "@/components/providers";

/**
 * Google is the primary way in (brief §4), so it sits above the email form and
 * carries the accent.
 *
 * It is a full navigation, not a fetch: `/auth/oauth/google/start` answers with a
 * 302 to Google, and PKCE state only works if the browser actually goes there.
 */
export function GoogleButton({
  label = "Continue with Google",
  loginHint,
}: {
  label?: string;
  loginHint?: string;
}): React.JSX.Element | null {
  const config = useRuntimeConfig();

  if (!config.googleOAuthEnabled) return null;

  const start = (): void => {
    const url = new URL("/auth/oauth/google/start", config.apiOrigin);
    url.searchParams.set("client", "web");
    if (loginHint !== undefined && loginHint !== "") url.searchParams.set("loginHint", loginHint);
    window.location.assign(url.toString());
  };

  return (
    <Button
      variant="primary"
      size="lg"
      onClick={start}
      data-testid="google-signin"
      className="w-full"
    >
      <GoogleMark />
      {label}
    </Button>
  );
}

/** Google's mark, inlined so the button does not depend on a third-party asset. */
function GoogleMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="currentColor"
        d="M21.35 11.1h-9.17v2.98h5.27c-.23 1.37-1.6 4.02-5.27 4.02-3.17 0-5.76-2.62-5.76-5.85s2.59-5.85 5.76-5.85c1.8 0 3.01.77 3.7 1.43l2.52-2.43C17.03 3.9 14.8 3 12.18 3 6.98 3 2.77 7.2 2.77 12.4s4.21 9.4 9.41 9.4c5.43 0 9.03-3.82 9.03-9.2 0-.62-.07-1.09-.16-1.5Z"
      />
    </svg>
  );
}

/** The visual separator between Google and the email form. */
export function AuthDivider(): React.JSX.Element | null {
  const config = useRuntimeConfig();
  if (!config.googleOAuthEnabled) return null;

  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="bg-border h-px flex-1" />
      <span className="text-fg-2 text-2xs uppercase">or</span>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}
