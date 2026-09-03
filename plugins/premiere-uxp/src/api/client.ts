/**
 * Shared API client (orchestrator addendum 2026-09-03, after C05a/C05b/C09): "Every panel
 * (Premiere, AE, Resolve Studio) still lacks a documented way to fetch a real project's style
 * document and segments to drive `applyCaptions`. Ruling: the panels call the existing API
 * through the bridge — `GET /styles` (A14) for style docs and `GET /projects/{id}/transcript`
 * (A11) / `GET /projects/{id}/edg/segments` (A12) for segments — wrapped in one shared client
 * module per plugin; D09 adds that wiring and its mock-backed tests alongside the apply-plan
 * builder."
 *
 * "Through the bridge" here means the same pattern `src/upload/mixdown.ts` already uses for
 * `POST /transcribe`: a plain HTTPS call to `API_ORIGIN` bearing the panel's own session token
 * (never the bridge's JSON-RPC protocol, which has no generic REST-proxy method — see
 * `src/bridge/protocol.ts`). This module takes the same injectable `HttpClient` shape
 * (`getJson`, mirroring that file's `postJson`) so it needs no network or a real bridge to test.
 */
export interface HttpGetClient {
  getJson<T>(url: string, headers: Record<string, string>): Promise<T>;
}

export interface ApiClientOptions {
  readonly http: HttpGetClient;
  readonly apiOrigin: string;
  readonly sessionToken: string;
}

/** Reduced shape of a `GET /styles` (A14) catalogue entry — only what apply/style-mapping code
 * needs, mirroring the "re-declared, not imported" rule `src/apply/types.ts` documents. */
export interface StyleCatalogueEntryLike {
  readonly presetId: string;
  readonly source: "system" | "custom";
  readonly [key: string]: unknown;
}

/** Reduced shape of one `GET /projects/{id}/transcript` (A11) chunk/segment row. */
export interface TranscriptChunkLike {
  readonly chunkIdx: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly words: readonly { wid: string; s: number; e: number; t: string }[];
}

export interface TranscriptResponseLike {
  readonly transcriptId: string;
  readonly revision: number;
  readonly language: string;
  readonly chunks: readonly TranscriptChunkLike[];
}

/** Reduced shape of one `GET /projects/{id}/edg/segments` (A12) row. */
export interface EdgSegmentResponseLike {
  readonly id: string;
  readonly seq: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly styleRef?: string;
}

export interface EdgSegmentsResponseLike {
  readonly revision: number;
  readonly segments: readonly EdgSegmentResponseLike[];
}

function authHeaders(sessionToken: string): Record<string, string> {
  return { Authorization: `Bearer ${sessionToken}` };
}

/**
 * `GET /styles` (A14): the style catalogue (system styles + this workspace's presets), used to
 * resolve a title/caption item's `styleRef` into an actual `StyleDoc` before mapping it to a
 * MOGRT/Text+ param table.
 */
export async function getStyles(options: ApiClientOptions): Promise<StyleCatalogueEntryLike[]> {
  return options.http.getJson<StyleCatalogueEntryLike[]>(
    `${options.apiOrigin}/styles`,
    authHeaders(options.sessionToken),
  );
}

/** `GET /projects/{id}/transcript` (A11): the project's transcript chunks/words. */
export async function getProjectTranscript(
  options: ApiClientOptions,
  projectId: string,
): Promise<TranscriptResponseLike> {
  return options.http.getJson<TranscriptResponseLike>(
    `${options.apiOrigin}/projects/${encodeURIComponent(projectId)}/transcript`,
    authHeaders(options.sessionToken),
  );
}

/** `GET /projects/{id}/edg/segments` (A12): the project's current EDG segments. */
export async function getProjectEdgSegments(
  options: ApiClientOptions,
  projectId: string,
): Promise<EdgSegmentsResponseLike> {
  return options.http.getJson<EdgSegmentsResponseLike>(
    `${options.apiOrigin}/projects/${encodeURIComponent(projectId)}/edg/segments`,
    authHeaders(options.sessionToken),
  );
}
