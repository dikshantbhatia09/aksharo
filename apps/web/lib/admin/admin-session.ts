"use client";

/**
 * The admin session: a `kind: "admin"` access token (CONTRACTS §5), minted
 * by `POST /admin/auth/step-up` and never refreshable. Kept in
 * `sessionStorage`, not the cookie/localStorage the regular app session
 * uses — it is a different, shorter-lived credential (30 minutes) for a
 * different surface, and must not survive a tab close the way "stay signed
 * in" does for the product app.
 */
const STORAGE_KEY = "aksharo_admin_session";

export interface AdminSession {
  readonly accessToken: string;
  readonly adminRoles: readonly string[];
  /** Epoch ms; `expiresIn` (seconds) from the step-up response, applied at store time. */
  readonly expiresAt: number;
}

export function readAdminSession(): AdminSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as AdminSession;
    if (parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function storeAdminSession(input: {
  readonly accessToken: string;
  readonly adminRoles: readonly string[];
  readonly expiresIn: number;
}): void {
  const session: AdminSession = {
    accessToken: input.accessToken,
    adminRoles: input.adminRoles,
    expiresAt: Date.now() + input.expiresIn * 1000,
  };
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearAdminSession(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function hasAdminRole(session: AdminSession, ...roles: readonly string[]): boolean {
  return (
    session.adminRoles.includes("superadmin") || roles.some((r) => session.adminRoles.includes(r))
  );
}
