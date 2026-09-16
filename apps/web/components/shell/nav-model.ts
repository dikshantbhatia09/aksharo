"use client";

import * as React from "react";

/**
 * The canvas ships the shell in two widths and lets the user pick between them
 * from the header: a 68 px icon rail and a 232 px sidebar. This is that choice.
 *
 * It is a per-browser preference, not workspace state, so it lives in
 * `localStorage` and never travels to the API. The first render is always
 * `"rail"` — the canvas's own default, and the only value the server can know —
 * and the stored preference is applied in an effect afterwards. Reading
 * storage during render would make the server and client markup disagree and
 * React would throw a hydration error over it.
 */
export type NavModel = "rail" | "sidebar";

const STORAGE_KEY = "aksharo.navModel";

function read(): NavModel | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "rail" || stored === "sidebar" ? stored : null;
  } catch {
    // Private mode, blocked site data, or a browser that throws on access.
    // A missing preference is not an error; it just means the default.
    return null;
  }
}

export function useNavModel(): readonly [NavModel, (next: NavModel) => void] {
  const [model, setModel] = React.useState<NavModel>("rail");

  React.useEffect(() => {
    const stored = read();
    if (stored !== null) setModel(stored);
  }, []);

  const choose = React.useCallback((next: NavModel) => {
    setModel(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies to this page; it just will not be remembered.
    }
  }, []);

  return [model, choose] as const;
}
