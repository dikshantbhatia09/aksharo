/**
 * Access-token state for one surface.
 *
 * The access token lives **in memory only** (CONTRACTS §5: 15 minutes, RS256).
 * Nothing here writes to `localStorage`: a token in web storage is readable by
 * any script that gets injected, and the refresh token — the long-lived one —
 * never reaches this module at all. In the browser it stays in an httpOnly
 * cookie that only a Next route handler can read (THREAT-MODEL T2).
 *
 * The store also knows when the token expires, so the shell can refresh a minute
 * early instead of waiting for a 401 in the middle of an upload.
 */

import type { ClientKind, WorkspaceRole } from "./types.js";

/** The `ws`, `role` and `sub` claims the shell renders from. */
export interface SessionSnapshot {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  kind: ClientKind;
  sessionId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Refresh this many milliseconds before the access token actually expires. */
export const REFRESH_SKEW_MS = 60_000;

type Listener = (snapshot: SessionSnapshot | null) => void;

export class SessionStore {
  private token: string | null = null;
  private snapshot: SessionSnapshot | null = null;
  private readonly listeners = new Set<Listener>();

  getAccessToken = (): string | null => this.token;

  getSnapshot = (): SessionSnapshot | null => this.snapshot;

  /** True when there is no token, or it expires inside the skew window. */
  isStale(now: number = Date.now()): boolean {
    return this.snapshot === null || this.snapshot.expiresAt - REFRESH_SKEW_MS <= now;
  }

  set(accessToken: string, snapshot?: SessionSnapshot): void {
    this.token = accessToken;
    this.snapshot = snapshot ?? decodeAccessToken(accessToken);
    this.emit();
  }

  clear(): void {
    this.token = null;
    this.snapshot = null;
    this.emit();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/** base64url → string, without assuming Node's `Buffer` exists. */
function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const base64 = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Read the claims of an access token **for display only**.
 *
 * The signature is not checked here and must never be: the API verifies it, and
 * a client that trusted its own parse would trust whatever a compromised page
 * put in the store. Everything this returns is a hint for rendering (which
 * workspace is active, when to refresh), never an authorisation decision.
 */
export function decodeAccessToken(token: string): SessionSnapshot | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
    const { sub, ws, role, kind, jti, exp } = claims;
    if (typeof sub !== "string" || typeof ws !== "string" || typeof exp !== "number") return null;
    return {
      userId: sub,
      workspaceId: ws,
      role: (typeof role === "string" ? role : "viewer") as WorkspaceRole,
      kind: (typeof kind === "string" ? kind : "web") as ClientKind,
      sessionId: typeof jti === "string" ? jti : "",
      expiresAt: exp * 1000,
    };
  } catch {
    return null;
  }
}
