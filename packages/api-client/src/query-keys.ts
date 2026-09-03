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
  affiliate: () => ["affiliate", "me"] as const,
  affiliateStats: () => ["affiliate", "me", "stats"] as const,
  deviceApproval: (userCode: string) => ["auth", "device", userCode] as const,
  jobs: (workspaceId: string) => ["ws", workspaceId, "jobs"] as const,
  job: (workspaceId: string, jobId: string) => ["ws", workspaceId, "jobs", jobId] as const,
  subscription: (workspaceId: string) => ["ws", workspaceId, "subscription"] as const,
  streak: (workspaceId: string) => ["ws", workspaceId, "streak"] as const,
  credits: (workspaceId: string) => ["ws", workspaceId, "credits"] as const,
  offersEligibility: (workspaceId: string) => ["ws", workspaceId, "offers", "eligibility"] as const,
  offersPasses: (workspaceId: string) => ["ws", workspaceId, "offers", "passes"] as const,
  referrals: (workspaceId: string) => ["ws", workspaceId, "referrals"] as const,
  academyProgress: (workspaceId: string) => ["ws", workspaceId, "academy", "progress"] as const,
  changelogDismissed: (workspaceId: string) =>
    ["ws", workspaceId, "academy", "changelog", "dismissed"] as const,
  supportTickets: (workspaceId: string) => ["ws", workspaceId, "support", "tickets"] as const,
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
  insights: (workspaceId: string, projectId: string) =>
    ["ws", workspaceId, "projects", projectId, "insights"] as const,
  members: (workspaceId: string) => ["ws", workspaceId, "members"] as const,
  devices: (workspaceId: string) => ["ws", workspaceId, "devices"] as const,
  licenseKeys: (workspaceId: string) => ["ws", workspaceId, "licenseKeys"] as const,
  pluginManifest: () => ["pluginManifest"] as const,
  clientTags: (workspaceId: string) => ["ws", workspaceId, "clientTags"] as const,
  apiKeys: (workspaceId: string) => ["ws", workspaceId, "apiKeys"] as const,
  webhooks: (workspaceId: string) => ["ws", workspaceId, "webhooks"] as const,
  webhookDeliveries: (workspaceId: string, endpointId: string) =>
    ["ws", workspaceId, "webhooks", endpointId, "deliveries"] as const,
  /** D04d: a signed pack-asset URL, cached per asset (the ten-minute TTL
   * `PACK_ASSET_URL_TTL_SECONDS` signs for) rather than per workspace — the
   * bytes at `packs/{packId}/{assetId}.wav` do not change per workspace, so
   * two projects previewing the same catalogue cue share the one fetch. */
  audioAssetUrl: (assetId: string) => ["audioAssets", assetId, "url"] as const,
} as const;

export type QueryKeys = typeof queryKeys;
