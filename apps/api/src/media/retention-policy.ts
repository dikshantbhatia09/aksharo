/**
 * Operator switches for the retention sweeps (owner decision 2026-09-29, when
 * clips opened to every workspace on a laptop-sized disk).
 *
 * - {@link RETENTION_EXEMPT_ENV}: workspaces no sweep touches - the owner's.
 *   A comma list of workspace ids; empty or missing means nobody is exempt.
 * - {@link RETENTION_PURGE_DERIVED_ENV}: whether the media sweep also deletes
 *   derived files (proxies, audio, waveforms, face tracks, thumbnails) when
 *   their `derived_purge_at` passes. Production sets it to 0: the owner chose
 *   "renders after 7 days, originals 7 days after their last job", and deleting
 *   a proxy stops an old project previewing. Absent means on, as before.
 *
 * Read from the process environment on every call, like
 * `INTERNAL_UNLIMITED_WORKSPACE_IDS`: a deployment's switch, not product
 * configuration.
 */
export const RETENTION_EXEMPT_ENV = "RETENTION_EXEMPT_WORKSPACE_IDS";
export const RETENTION_PURGE_DERIVED_ENV = "RETENTION_PURGE_DERIVED";

/** The exempt workspace ids, deduplicated, in the order given. */
export function retentionExemptWorkspaceIds(
  source: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = source[RETENTION_EXEMPT_ENV] ?? "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return [...new Set(ids)];
}

/** Whether derived files are purged too (default true). */
export function retentionPurgesDerived(source: NodeJS.ProcessEnv = process.env): boolean {
  // eslint-disable-next-line security/detect-object-injection -- a constant env var name, not input
  const raw = (source[RETENTION_PURGE_DERIVED_ENV] ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * A Prisma `where` fragment that leaves the exempt workspaces out, for a model
 * with a `workspaceId` column. Empty when nobody is exempt, so a query without
 * exemptions is exactly what it was.
 */
export function notExemptWorkspace(exempt: readonly string[]): {
  workspaceId?: { notIn: string[] };
} {
  return exempt.length === 0 ? {} : { workspaceId: { notIn: [...exempt] } };
}
