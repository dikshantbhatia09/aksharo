/**
 * Queue contract for the render service (docs/CONTRACTS.md section 3).
 * A08 lifts these declarations into the shared jobs contract.
 */

export const RENDER_VIDEO_QUEUE = "render.video" as const;
export const RENDER_SUBTITLE_QUEUE = "render.subtitle" as const;

/** Every job's `data` (CONTRACTS section 3). */
export interface JobEnvelope<TPayload = unknown> {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly priority: number;
  readonly jobKey: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly payload: TPayload;
}

/** Payload of a `render.video` job. A20 fills in the real fields. */
export interface RenderVideoPayload {
  readonly exportId: string;
  readonly edgId: string;
  readonly revision: number;
  /** "1080p" | "4k" and so on; A21 owns the preset list. */
  readonly preset?: string;
}

/** Result A20 will return; A01 returns the stub shape only. */
export interface RenderVideoResult {
  readonly exportId: string;
  /** R2 key under `ws/{workspaceId}/p/{projectId}/exports/` (CONTRACTS section 6). */
  readonly outputKey: string | null;
  readonly outputMs: number | null;
  readonly renderedAt: string;
  readonly stub: boolean;
}

export function isJobEnvelope(value: unknown): value is JobEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["jobId"] === "string" &&
    typeof candidate["attemptId"] === "string" &&
    typeof candidate["workspaceId"] === "string" &&
    typeof candidate["jobKey"] === "string" &&
    typeof candidate["createdAt"] === "string" &&
    "payload" in candidate
  );
}
