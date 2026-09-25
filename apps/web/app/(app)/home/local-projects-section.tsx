"use client";

/**
 * "Local projects" (brief C04 §2): desktop-only, Starter+ only. Renders
 * nothing outside the desktop shell (`getDesktopApi()` is `null` in a
 * browser tab) and nothing on a build too old to expose `local` — the
 * optional chaining throughout is that fallback, not a defensive habit.
 *
 * Deliberately its own file rather than folded into `home-view.tsx`: the
 * whole section is one `{condition && <LocalProjectsSection />}` there, so a
 * reviewer can see at a glance that nothing else on Home changed.
 */
import * as React from "react";

import type { DesktopLocalProject } from "@/lib/desktop";

import { getDesktopApi } from "@/lib/desktop";

interface LocalProjectsState {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly projects: readonly DesktopLocalProject[];
  readonly loading: boolean;
}

/** Reads local mode's availability and project list; `null` outside the desktop shell. */
function useLocalProjects(): LocalProjectsState | null {
  const api = getDesktopApi();
  const [state, setState] = React.useState<LocalProjectsState | null>(
    api?.local === undefined
      ? null
      : { supported: true, enabled: false, projects: [], loading: true },
  );

  React.useEffect(() => {
    if (api?.local === undefined) return;
    const local = api.local;
    let cancelled = false;
    void (async () => {
      const enabled = await local.isEnabled();
      const projects = enabled ? await local.listProjects() : [];
      if (!cancelled) setState({ supported: true, enabled, projects, loading: false });
    })();
    return () => {
      cancelled = true;
    };
    // `api` is read once per mount (the preload surface never changes shape mid-session);
    // deliberately not a dependency of this effect.
  }, [api?.local]);

  return state;
}

export function LocalProjectsSection(): React.JSX.Element | null {
  const state = useLocalProjects();
  if (state === null || !state.supported) return null;

  if (!state.enabled) {
    return (
      <div className="flex flex-col gap-3" data-testid="local-projects-upgrade">
        <h2 className="text-fg-0 text-lg font-semibold">Local projects</h2>
        <p className="text-fg-2 text-sm">
          Edit fully offline, no upload, on Starter and above.{" "}
          <a
            className="text-accent-300 hover:text-accent-200 underline underline-offset-4"
            href="/settings/billing"
          >
            Upgrade your plan
          </a>{" "}
          to turn it on.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="local-projects-section">
      <h2 className="text-fg-0 text-lg font-semibold">Local projects</h2>
      {state.loading ? (
        <p className="text-fg-2 text-sm">Loading…</p>
      ) : state.projects.length === 0 ? (
        <p className="text-fg-2 text-sm">
          Nothing here yet. Local projects stay on this device until you choose "Upload to cloud".
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.projects.map((project) => (
            <li key={project.id} className="text-fg-0 text-sm">
              {project.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
