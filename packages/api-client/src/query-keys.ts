/**
 * One place that decides what a cache entry is called.
 *
 * Every key starts with the workspace id, because switching workspaces mints a
 * new token (CONTRACTS §5) and must not show the previous workspace's data for
 * even one frame. `queryKeys.workspaceScope(id)` is what a workspace switch
 * invalidates.
 */

export const queryKeys = {
  session: () => ["session"] as const,
  me: () => ["me"] as const,
  workspaces: () => ["workspaces"] as const,
  workspaceScope: (workspaceId: string) => ["ws", workspaceId] as const,
  entitlement: (workspaceId: string) => ["ws", workspaceId, "entitlement"] as const,
  usage: (workspaceId: string) => ["ws", workspaceId, "usage"] as const,
  sessions: () => ["auth", "sessions"] as const,
  consents: () => ["consents"] as const,
  memory: () => ["memory"] as const,
  deviceApproval: (userCode: string) => ["auth", "device", userCode] as const,
  jobs: (workspaceId: string) => ["ws", workspaceId, "jobs"] as const,
  job: (workspaceId: string, jobId: string) => ["ws", workspaceId, "jobs", jobId] as const,
  subscription: (workspaceId: string) => ["ws", workspaceId, "subscription"] as const,
  credits: (workspaceId: string) => ["ws", workspaceId, "credits"] as const,
  offersEligibility: (workspaceId: string) => ["ws", workspaceId, "offers", "eligibility"] as const,
  offersPasses: (workspaceId: string) => ["ws", workspaceId, "offers", "passes"] as const,
  /**
   * Jobs for one project (a card's progress poll). Nested *under* `jobs()`
   * (`["ws", id, "jobs", "byProject", projectId]`), not under `projects()`, on
   * purpose: `AppShell` already invalidates every `["ws", workspaceId, "jobs"]`
   * query on every `job.progress` / `job.completed` realtime event (08 §2), and
   * TanStack Query's partial key matching only catches a query nested under
   * that prefix. Nesting this under `projects()` instead would silently drop
   * back to the polling fallback for every project card, realtime channel
   * connected or not.
   */
  projectJobs: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "jobs", "byProject", projectId] as const,
  projects: (workspaceId: string, query: Readonly<Record<string, unknown>> = {}) =>
    ["ws", workspaceId, "projects", query] as const,
  project: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "projects", projectId] as const,
  projectMedia: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "projects", projectId, "media"] as const,
  folders: (workspaceId: string) => ["ws", workspaceId, "folders"] as const,
  styles: (workspaceId: string) => ["ws", workspaceId, "styles"] as const,
  transcriptScripts: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "projects", projectId, "transcript", "scripts"] as const,
} as const;

export type QueryKeys = typeof queryKeys;
