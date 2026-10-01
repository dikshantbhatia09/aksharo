"use client";

/**
 * The caption styles a signed-in page draws with (2026-10-01): the system
 * catalogue plus the looks the workspace saved itself ("My templates",
 * `GET /styles`'s custom entries), so a clip made on a saved look previews in
 * it rather than in the default style. Until the workspace's looks load, and
 * for a workspace with none, it is the system catalogue itself.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { endpoints, queryKeys, useApiClient, useWorkspaceId } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";

import { SYSTEM_STYLE_MAP } from "./system-styles";

export function useStyleCatalogue(enabled = true): ReadonlyMap<string, StyleDoc> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  // `useStyles`' own query (same key, so one fetch serves both), with a switch.
  const styles = useQuery({
    queryKey: queryKeys.styles(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    staleTime: 60_000,
    queryFn: () => client.call(endpoints.styles.list),
  });
  return useMemo(() => {
    const custom = (styles.data ?? []).filter((entry) => entry.source === "custom");
    if (custom.length === 0) return SYSTEM_STYLE_MAP;
    return new Map([
      ...SYSTEM_STYLE_MAP,
      ...custom.map((entry) => [entry.id, entry as unknown as StyleDoc] as const),
    ]);
  }, [styles.data]);
}
