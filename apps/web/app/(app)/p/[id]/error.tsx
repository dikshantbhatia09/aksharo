"use client";

import * as React from "react";

/**
 * The editor's own error boundary.
 *
 * The editor is the one screen that runs a GPU renderer (CanvasKit) over a
 * document the user has been editing, so it is where a throw is most likely and
 * most expensive: before this existed, an unknown style id or a stale segment
 * reference took down the entire page and the user lost their place with no
 * message beyond "a client-side exception has occurred".
 *
 * A failure here keeps the shell and offers the two things that actually help:
 * re-render the editor, or leave for the projects list. The document itself is
 * safe — every edit was already committed as an op server-side.
 */
export default function EditorError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error("[editor] unhandled error", error);
  }, [error]);

  return (
    <div
      className="flex h-[calc(100dvh-3.5rem)] flex-col items-center justify-center gap-3 p-8 text-center"
      data-testid="editor-error-boundary"
      role="alert"
    >
      <h2 className="text-fg-0 text-lg font-semibold">The editor hit a problem</h2>
      <p className="text-fg-2 max-w-md text-sm">
        Your edits are saved — every change is written to the server as you make it. Reloading the
        editor is safe.
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
          data-testid="editor-error-retry"
        >
          Reload the editor
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
