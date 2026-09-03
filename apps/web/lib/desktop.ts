/**
 * Desktop-shell detection hook (C02 file boundary: the one `apps/web` file
 * this WP may touch, agreed with A13). The desktop shell loads the hosted app
 * with a `?desktop=1` marker and a `User-Agent` suffix `AksharoDesktop/<version>`
 * (`apps/desktop/src/main/index.ts`); this module is the single place the web
 * app checks for either signal, and the typed accessor for the preload API
 * the desktop shell exposes at `window.aksharoDesktop`
 * (`apps/desktop/src/preload/api-types.ts` — kept in sync by hand until both
 * sides share a types package).
 *
 * Pure / no server dependency so it works in both client components and tests.
 */

const USER_AGENT_MARKER = /AksharoDesktop\/([\w.-]+)/;

export interface DesktopEnvironment {
  isDesktop: boolean;
  version: string | null;
}

/** Detects the desktop shell from a `?desktop=1` query flag and/or User-Agent suffix. */
export function detectDesktopEnvironment(input: {
  searchParams?: URLSearchParams | null;
  userAgent?: string | null;
}): DesktopEnvironment {
  const fromQuery = input.searchParams?.get("desktop") === "1";
  const match = input.userAgent ? USER_AGENT_MARKER.exec(input.userAgent) : null;
  return {
    isDesktop: fromQuery || match !== null,
    version: match?.[1] ?? null,
  };
}

export type DesktopLocalMediaRole = "primary" | "broll" | "audio";
export type DesktopLocalExportStatus = "pending" | "done" | "failed";

export interface DesktopLocalProject {
  readonly id: string;
  readonly title: string;
  readonly aspect: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DesktopLocalMedia {
  readonly id: string;
  readonly projectId: string;
  readonly role: DesktopLocalMediaRole;
  readonly filePath: string;
  readonly durationMs: number | null;
  readonly fps: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly importedAt: string;
}

/**
 * `hot`/`segments` are `EdgHot`/`Segment[]` from `@montaj/edg/schemas`
 * (already a dependency of this app); left as `unknown` here rather than
 * imported, matching `apps/desktop/src/preload/api-types.ts`'s own choice
 * to keep this boundary's surface free of a second copy of the EDG types —
 * `apps/web/lib/edg/store.ts`'s local branch is the one place that casts
 * them back to their real shape.
 */
export interface DesktopLocalEdgSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly hot: unknown;
  readonly segments: unknown[];
  readonly createdAt: string;
}

export interface DesktopLocalExport {
  readonly id: string;
  readonly projectId: string;
  readonly outputPath: string;
  readonly status: DesktopLocalExportStatus;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** Local mode (brief C04): the desktop's `window.aksharoDesktop.local` surface. */
export interface AksharoDesktopLocalApi {
  isEnabled(): Promise<boolean>;
  createProject(input: { title: string; aspect: string }): Promise<DesktopLocalProject>;
  listProjects(): Promise<DesktopLocalProject[]>;
  openProject(projectId: string): Promise<DesktopLocalProject>;
  deleteProject(projectId: string): Promise<{ ok: true }>;
  importMedia(input: {
    projectId: string;
    sourcePath: string;
    role: DesktopLocalMediaRole;
  }): Promise<DesktopLocalMedia>;
  listMedia(projectId: string): Promise<DesktopLocalMedia[]>;
  transcribe(input: { audio: string; language?: string }): Promise<unknown>;
  align(input: { audio: string; words: string[]; language: string }): Promise<unknown>;
  saveEdgSnapshot(input: {
    projectId: string;
    hot: unknown;
    segments: unknown[];
  }): Promise<DesktopLocalEdgSnapshot>;
  latestSnapshot(projectId: string): Promise<DesktopLocalEdgSnapshot | null>;
  runExport(input: {
    projectId: string;
    drawCommandsPath: string;
    width: number;
    height: number;
    fps: number;
    outputPath: string;
  }): Promise<DesktopLocalExport>;
  listExports(projectId: string): Promise<DesktopLocalExport[]>;
}

/** Type of the API the desktop preload exposes (subset the web app is allowed to rely on). */
export interface AksharoDesktopWindowApi {
  version: string;
  platform: string;
  openMediaDialog(): Promise<string[]>;
  engine: { status(): Promise<{ state: string }> };
  bridge: { pair(pairCode: string): Promise<{ ok: boolean; error?: string }> };
  updates: { check(): Promise<{ channel: string; available: boolean; version?: string }> };
  deepLink: { onOpen(listener: (url: string) => void): () => void };
  /** Local mode (brief C04). Undefined on a desktop build older than this WP. */
  local?: AksharoDesktopLocalApi;
}

/** Returns the desktop preload API when running inside the desktop shell, else `null`. */
export function getDesktopApi(): AksharoDesktopWindowApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { aksharoDesktop?: AksharoDesktopWindowApi }).aksharoDesktop;
  return api ?? null;
}
