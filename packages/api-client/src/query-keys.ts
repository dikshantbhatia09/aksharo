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
  transcriptScripts: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "projects", projectId, "transcript", "scripts"] as const,
} as const;

export type QueryKeys = typeof queryKeys;
