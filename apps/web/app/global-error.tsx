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
 * deliberately uses inline styles only. The values below are the Shirorekha
 * tokens written out (`packages/ui/src/styles/tokens.css`); keep them in step if
 * the palette is retuned. Contrast: fg-0 on bg-0 15.4:1, fg-2 on sunken 7.1:1,
 * ink on the rani fill 5.5:1.
 */
const TOKENS = {
  bg0: "#141217",
  surface: "#1f1c23",
  sunken: "#0e0c10",
  border: "#36313a",
  fg0: "#f1ece6",
  fg1: "#d6cfc8",
  fg2: "#a39a93",
  accent: "#f0508a",
  onAccent: "#141217",
} as const;

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
          alignItems: "center",
          justifyContent: "center",
          background: TOKENS.bg0,
          color: TOKENS.fg0,
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <main
          role="alert"
          style={{
            width: "100%",
            maxWidth: "36rem",
            display: "flex",
            flexDirection: "column",
            gap: "1rem",
            background: TOKENS.surface,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: "10px",
            padding: "1.5rem",
            boxSizing: "border-box",
          }}
        >
          <h1 style={{ fontSize: "1.125rem", lineHeight: 1.4, fontWeight: 600, margin: 0 }}>
            Aksharo could not load
          </h1>
          <p style={{ fontSize: "0.875rem", lineHeight: 1.45, color: TOKENS.fg1, margin: 0 }}>
            Something failed before the app could start. Reloading usually fixes it; your projects
            and edits are stored on the server and are not affected.
          </p>
          <pre
            style={{
              margin: 0,
              maxHeight: "12rem",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              border: `1px solid ${TOKENS.border}`,
              background: TOKENS.sunken,
              padding: "0.75rem",
              fontSize: "0.75rem",
              color: TOKENS.fg2,
              borderRadius: "6px",
            }}
          >
            {error.message}
            {error.digest === undefined ? "" : `\n\ndigest: ${error.digest}`}
          </pre>
          <button
            type="button"
            onClick={reset}
            style={{
              alignSelf: "flex-start",
              minHeight: "36px",
              background: TOKENS.accent,
              color: TOKENS.onAccent,
              border: 0,
              borderRadius: "6px",
              padding: "0 1rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
