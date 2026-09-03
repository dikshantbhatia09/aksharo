import "server-only";

import { readRuntimeConfig } from "@/lib/runtime-config";

export type StatusComponentStatus = "operational" | "degraded" | "down";

export interface StatusComponent {
  readonly id: string;
  readonly label: string;
  readonly status: StatusComponentStatus;
  readonly detail?: string;
}

export interface StatusIncident {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly component: string;
  readonly severity: "minor" | "major" | "critical";
  readonly status: "investigating" | "monitoring" | "resolved";
  readonly startedAt: string;
  readonly resolvedAt: string | null;
}

export interface StatusSnapshot {
  readonly generatedAt: string;
  readonly overall: StatusComponentStatus;
  readonly components: readonly StatusComponent[];
  readonly incidents: readonly StatusIncident[];
}

const FALLBACK_SNAPSHOT: StatusSnapshot = {
  generatedAt: new Date(0).toISOString(),
  overall: "degraded",
  components: [],
  incidents: [],
};

/**
 * Fetch the API's published `status.json` (`apps/api/src/ops/status.controller.ts`).
 *
 * `cache: "no-store"`: a status page serving a stale "all operational" during a
 * real outage is worse than one that is briefly slow. A fetch failure (the API
 * itself unreachable) renders the fallback below — degraded, with an honest
 * explanatory component — rather than throwing and taking the whole page down;
 * "the status page is never itself the outage" (`status.controller.ts`)
 * applies here too.
 */
export async function loadStatusSnapshot(): Promise<StatusSnapshot> {
  const { apiOrigin } = readRuntimeConfig();
  try {
    const response = await fetch(`${apiOrigin}/ops/status.json`, { cache: "no-store" });
    if (!response.ok) return unreachableSnapshot();
    return (await response.json()) as StatusSnapshot;
  } catch {
    return unreachableSnapshot();
  }
}

function unreachableSnapshot(): StatusSnapshot {
  return {
    ...FALLBACK_SNAPSHOT,
    generatedAt: new Date().toISOString(),
    components: [
      {
        id: "status-page",
        label: "Status service",
        status: "down",
        detail: "Could not reach the status API.",
      },
    ],
  };
}
