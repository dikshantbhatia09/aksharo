"use client";

import Link from "next/link";
import * as React from "react";

import { Button } from "@montaj/ui";

/**
 * The signed-in app's error boundary.
 *
 * Without one, a throw anywhere under `(app)` — a renderer that meets a style id
 * it does not know, a panel that reads a segment that has just been resegmented
 * away — unmounts the whole tree and Next.js paints its own bare
 * "Application error: a client-side exception has occurred", with the real
 * message only in the console. That is what the 2026-09-05 report described, and
 * it made every failure look identical and unrecoverable.
 *
 * This keeps the failure local: the shell stays, the message is shown, and
 * `reset()` re-renders the segment so the user can carry on without losing the
 * session. It deliberately shows the real message — this is a creator tool, and
 * "something went wrong" costs a support round-trip.
 *
 * Shape: it stands in for the page that failed, so its heading is the page's
 * `h1`, but it carries no shirorekha — the bar marks a page's own title, and an
 * error is not a destination. One primary ("Try again", the likeliest fix) and
 * one secondary way out (HIG Writing › Write clear error messages: say what
 * happened and what to do, no apology).
 */
export default function AppError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error("[app] unhandled error", error);
  }, [error]);

  return (
    <div
      className="flex min-h-[60dvh] flex-col items-center justify-center px-4 py-10"
      data-testid="app-error-boundary"
      role="alert"
    >
      <div className="border-border bg-surface flex w-full max-w-xl flex-col gap-4 rounded-md border p-5 sm:p-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-fg-0 text-lg font-semibold">This screen stopped working</h1>
          <p className="text-fg-1 text-sm">
            The rest of Aksharo is still running and your work is saved on the server. Try again;
            if it keeps happening, send support the message below and what you were doing.
          </p>
        </div>
        <pre className="border-border bg-sunken text-fg-2 scrollbar-thin max-h-48 overflow-auto rounded-sm border p-3 font-mono text-xs whitespace-pre-wrap">
          {error.message}
          {error.digest === undefined ? "" : `\n\ndigest: ${error.digest}`}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={reset} data-testid="app-error-retry">
            Try again
          </Button>
          <Button variant="secondary" asChild>
            <Link href="/projects">Back to projects</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
