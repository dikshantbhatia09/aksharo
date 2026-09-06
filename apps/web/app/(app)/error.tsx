"use client";

import * as React from "react";

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
      className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="app-error-boundary"
      role="alert"
    >
      <h2 className="text-fg-0 text-lg font-semibold">This screen hit a problem</h2>
      <p className="text-fg-2 max-w-md text-sm">
        The rest of the app is still running. Try again, and if it keeps happening tell support what
        you were doing.
      </p>
      <pre className="text-fg-3 max-w-xl overflow-x-auto rounded border border-white/10 bg-black/30 p-3 text-left text-xs">
        {error.message}
        {error.digest === undefined ? "" : `\n\ndigest: ${error.digest}`}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15"
          data-testid="app-error-retry"
        >
          Try again
        </button>
        <a
          href="/projects"
          className="text-fg-2 hover:text-fg-0 rounded px-3 py-1.5 text-sm font-medium underline"
        >
          Back to projects
        </a>
      </div>
    </div>
  );
}
