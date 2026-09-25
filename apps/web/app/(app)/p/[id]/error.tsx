"use client";

import Link from "next/link";
import * as React from "react";

import { Button, PageHeader } from "@montaj/ui";

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
      className="mx-auto flex h-dvh w-full max-w-xl flex-col justify-center gap-6 px-4 sm:px-6"
      data-testid="editor-error-boundary"
      role="alert"
    >
      <PageHeader
        title="The editor hit a problem"
        description="Your edits are saved: every change is written to the server as you make it, so reloading the editor is safe."
      />
      <details className="border-border bg-sunken rounded-md border p-3 text-xs">
        <summary className="text-fg-2 cursor-pointer rounded-sm">Technical details</summary>
        <pre className="text-fg-1 mt-2 overflow-x-auto font-mono whitespace-pre-wrap">
          {error.message}
          {error.digest === undefined
            ? ""
            : `

digest: ${error.digest}`}
        </pre>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={reset} data-testid="editor-error-retry">
          Reload the editor
        </Button>
        <Button asChild variant="ghost">
          <Link href="/projects">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}
