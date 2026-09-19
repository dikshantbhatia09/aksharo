"use client";

import * as React from "react";

import { useFeatureFlag, useProjects } from "@montaj/api-client";
import { surfaceEnabled } from "@montaj/config";

import type { NavItem } from "@/lib/nav";

import { REPURPOSE_FLOW_FLAG } from "@/components/home/pipeline-banner";
import { useRuntimeConfig } from "@/components/providers";
import { PRIMARY_NAV, SECONDARY_NAV } from "@/lib/nav";

/**
 * Two entries in the canvas's rail cannot be static links, and this is where
 * they are resolved against what the workspace actually has.
 *
 * **Editor.** The canvas has an "Editor" entry, but this app's editor is
 * `/p/[id]` — it needs a project, and a rail button cannot invent one. So it
 * resolves to the workspace's most recently updated project and goes disabled
 * when there is none. Sending a new user to `/projects` under the label
 * "Editor" would be a lie about where the click goes; a disabled row with a
 * reason is not.
 *
 * **Clips pipeline.** `repurpose_flow` is targeted at one workspace
 * (CLAUDE.md §1), and the canvas's rail puts this entry FIRST. Left ungated it
 * would be the topmost button for every user outside that cohort, leading to a
 * screen that only says the feature is not on for them — and it would be the
 * one always-visible trace of the surface, since the studio's own
 * `PipelineBanner` renders nothing when the flag is off. The entry therefore
 * takes the same disabled treatment as Editor, from the same per-workspace
 * entitlement snapshot the destination reads.
 *
 * The project query is deliberately the same `useProjects({ limit: 8 })` the
 * shell already runs for the command palette's "Recent projects" group, so
 * this shares that cache entry rather than adding a request. `useFeatureFlag`
 * reads the entitlement the shell has already fetched, for the same reason.
 *
 * While the entitlement is still loading the flag reads false, so the entry
 * starts disabled and enables a moment later. That is the right way round: an
 * entry point that flickers IN is a gated feature briefly offered to someone
 * who does not have it.
 */
export function useNavItems(): {
  readonly primary: readonly NavItem[];
  readonly secondary: readonly NavItem[];
} {
  const projects = useProjects({ limit: 8 });
  const newest = projects.data?.pages[0]?.items[0];
  const repurposeEnabled = useFeatureFlag(REPURPOSE_FLOW_FLAG);

  const primary = React.useMemo(
    () =>
      PRIMARY_NAV.map((item) => {
        if (item.key === "repurpose") {
          if (repurposeEnabled) return item;
          return {
            ...item,
            ready: false,
            disabledBadge: "Soon",
            disabledNote:
              "The clips pipeline is not on for this workspace yet. We will let you know when it reaches you.",
          };
        }

        if (item.key !== "editor") return item;
        if (newest === undefined) {
          return {
            ...item,
            ready: false,
            disabledBadge: "Empty",
            disabledNote: "The editor opens a project. Upload something first.",
          };
        }
        return { ...item, href: `/p/${newest.id}` };
      }),
    [newest, repurposeEnabled],
  );

  const config = useRuntimeConfig();
  const pluginsEnabled = surfaceEnabled("plugins", config.flags);
  const affiliatesEnabled = surfaceEnabled("affiliates", config.flags);

  const secondary = React.useMemo(
    () =>
      SECONDARY_NAV.filter((item) => {
        if (item.key === "plugins" && !pluginsEnabled) return false;
        if (item.key === "affiliate" && !affiliatesEnabled) return false;
        return true;
      }),
    [pluginsEnabled, affiliatesEnabled],
  );

  return { primary, secondary };
}
