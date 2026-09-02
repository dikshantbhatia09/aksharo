/**
 * Renderer-side script for the packaged offline page. Kept tiny and dependency
 * free so it can ship inside the strict-CSP `offline.html` (`script-src
 * 'self'`, no inline). Posts a message the main process listens for to retry
 * loading the hosted app (see `src/main/index.ts`).
 *
 * Runs in a plain (non-Node) renderer, hence the explicit `dom` lib reference
 * rather than pulling `dom` into the whole package's (Node-targeted) tsconfig.
 */
/// <reference lib="dom" />
document.getElementById("retry")?.addEventListener("click", () => {
  window.location.href = "aksharo-offline-retry:";
});
