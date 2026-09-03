"use client";

import { readAdminSession } from "./admin-session";

export class AdminFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Every admin route past step-up, called with the ADMIN session's own
 * bearer token — never the shared `@montaj/api-client` (its `getAccessToken`
 * is wired to the regular product session, a different, longer-lived
 * credential `AdminGuard` no longer accepts, CONTRACTS §5).
 */
export async function adminFetch<T>(
  apiOrigin: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = readAdminSession();
  if (session === null) {
    throw new AdminFetchError("No admin session — step up again.", 401, "admin/no_session");
  }

  const response = await fetch(`${apiOrigin}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text === "" ? undefined : JSON.parse(text);

  if (!response.ok) {
    const envelope = parsed as { error?: { code?: string; message?: string } } | undefined;
    throw new AdminFetchError(
      envelope?.error?.message ?? `Request failed (${String(response.status)}).`,
      response.status,
      envelope?.error?.code,
    );
  }

  return parsed as T;
}
