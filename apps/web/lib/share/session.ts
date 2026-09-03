"use client";

/**
 * Client-side storage for a share link's `X-Share-Session` header (B15 brief
 * §1: a password-gated link is unlocked once, then replayed).
 *
 * `sessionStorage`, not a cookie or `localStorage`: the API sets no cookie
 * middleware (see `apps/api/src/share/share.constants.ts`'s header comment),
 * and a share-link unlock is meant to last "this visit", not forever on this
 * device — closing the tab and coming back re-asks for the password, which is
 * the safer default for a link that may have been pasted into a group chat.
 */

const KEY_PREFIX = "montaj:share-session:";

export function getShareSession(token: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage.getItem(KEY_PREFIX + token) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setShareSession(token: string, session: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY_PREFIX + token, session);
  } catch {
    // Private-browsing / storage-full: the unlock still works for this
    // render, it just re-asks on the next one. Not worth surfacing an error.
  }
}
