/**
 * The shape of `status.json` (X04 §1) — what `StatusPublishTask` writes to
 * `ops_status_snapshots.payload` and what the public `GET /ops/status.json`
 * and the marketing site's `/status` page both read back unchanged.
 *
 * Kept in its own file, with a runtime `zod` twin, so the task that produces
 * it and the controller that serves it can never drift: both import
 * {@link StatusSnapshotSchema} rather than hand-writing the shape twice.
 */
import { z } from "zod";

export const STATUS_COMPONENT_STATUSES = ["operational", "degraded", "down"] as const;
export type StatusComponentStatus = (typeof STATUS_COMPONENT_STATUSES)[number];

export const StatusComponentSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(STATUS_COMPONENT_STATUSES),
  /** Round-trip time or other short diagnostic, never a credential. */
  detail: z.string().optional(),
});
export type StatusComponent = z.infer<typeof StatusComponentSchema>;

export const StatusIncidentSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  component: z.string(),
  severity: z.enum(["minor", "major", "critical"]),
  status: z.enum(["investigating", "monitoring", "resolved"]),
  startedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type StatusIncident = z.infer<typeof StatusIncidentSchema>;

export const StatusSnapshotSchema = z.object({
  generatedAt: z.string(),
  overall: z.enum(STATUS_COMPONENT_STATUSES),
  components: z.array(StatusComponentSchema),
  incidents: z.array(StatusIncidentSchema),
});
export type StatusSnapshotPayload = z.infer<typeof StatusSnapshotSchema>;

/** Worst status wins: `down` > `degraded` > `operational`. */
export function worstStatus(statuses: readonly StatusComponentStatus[]): StatusComponentStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "operational";
}
