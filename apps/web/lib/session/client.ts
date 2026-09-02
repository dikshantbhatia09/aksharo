"use client";

import type { TokenResponse } from "@montaj/api-client";

/**
 * The browser half of the session.
 *
 * Every function here talks to this app's own origin, never to the API: the
 * refresh token is in an httpOnly cookie the page cannot read, so storing,
 * rotating and dropping it are all route-handler calls.
 */

/** Hand a fresh token pair to the route handler that owns the cookie. */
export async function persistSession(tokens: TokenResponse): Promise<void> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!response.ok) {
    // The status matters when this fails: 403 means the origin check rejected
    // the write, anything else is the route handler itself.
    throw new Error(`Could not store the session (${String(response.status)}).`);
  }
}

/** Drop the cookie. Safe to call when there is no session. */
export async function clearSession(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
}

export interface RefreshResult {
  accessToken: string;
  expiresIn: number;
  workspaceId: string | null;
  role: string | null;
}

/**
 * Rotate. Returns `null` when the session is over — a revoked family, an expired
 * one, or no cookie at all — which is the shell's signal to sign out.
 */
export async function refreshSession(): Promise<RefreshResult | null> {
  let response: Response;
  try {
    response = await fetch("/api/session/refresh", { method: "POST" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await response.json()) as RefreshResult;
  } catch {
    return null;
  }
}

/** Whether a session cookie exists, without reading it. */
export async function hasSessionCookie(): Promise<boolean> {
  try {
    const response = await fetch("/api/session", { method: "GET" });
    if (!response.ok) return false;
    const body = (await response.json()) as { authenticated?: boolean };
    return body.authenticated === true;
  } catch {
    return false;
  }
}
