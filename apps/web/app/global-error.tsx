"use client";

import * as React from "react";

/**
 * The last-resort boundary: a throw in the root layout itself, which the
 * per-segment boundaries never see. It replaces Next.js's own bare
 * "Application error: a client-side exception has occurred" screen, which said
 * nothing and offered nothing.
 *
 * It renders its own `<html>`/`<body>` by contract — the failing layout above it
 * is gone — so it cannot use the app's providers, fonts or design tokens, and
 * deliberately uses inline styles only.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error("[global] unhandled error", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          background: "#0b0b0c",
          color: "#e8e8ea",
          fontFamily: "system-ui, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>Aksharo could not load</h1>
        <p style={{ maxWidth: "32rem", fontSize: "0.875rem", color: "#a1a1aa", margin: 0 }}>
          Something failed before the app could start. Reloading usually fixes it; your projects and
          edits are stored on the server and are not affected.
        </p>
        <pre
          style={{
            maxWidth: "40rem",
            overflowX: "auto",
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.35)",
            padding: "0.75rem",
            fontSize: "0.75rem",
            textAlign: "left",
            color: "#a1a1aa",
            borderRadius: "0.25rem",
          }}
        >
          {error.message}
          {error.digest === undefined ? "" : `\n\ndigest: ${error.digest}`}
        </pre>
        <button
          type="button"
          onClick={reset}
          style={{
            background: "rgba(255,255,255,0.1)",
            color: "inherit",
            border: 0,
            borderRadius: "0.25rem",
            padding: "0.375rem 0.75rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
