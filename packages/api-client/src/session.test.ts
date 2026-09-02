import { describe, expect, it, vi } from "vitest";

import { decodeAccessToken, REFRESH_SKEW_MS, SessionStore } from "./session.js";

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function token(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: "RS256", typ: "JWT" })}.${base64Url(claims)}.signature`;
}

const CLAIMS = {
  sub: "01JUSER",
  ws: "01JWORKSPACE",
  role: "owner",
  kind: "web",
  jti: "01JSESSION",
  iat: 1_760_000_000,
  exp: 1_760_000_900,
};

describe("decodeAccessToken", () => {
  it("reads the claims of CONTRACTS §5", () => {
    expect(decodeAccessToken(token(CLAIMS))).toEqual({
      userId: "01JUSER",
      workspaceId: "01JWORKSPACE",
      role: "owner",
      kind: "web",
      sessionId: "01JSESSION",
      expiresAt: 1_760_000_900_000,
    });
  });

  it("returns null for anything that is not a three-part JWT", () => {
    expect(decodeAccessToken("not-a-token")).toBeNull();
    expect(decodeAccessToken("a.b")).toBeNull();
    expect(decodeAccessToken("a.%%%.c")).toBeNull();
  });

  it("returns null when the required claims are missing", () => {
    expect(decodeAccessToken(token({ sub: "u", exp: 1 }))).toBeNull();
    expect(decodeAccessToken(token({ ws: "w", exp: 1 }))).toBeNull();
  });
});

describe("SessionStore", () => {
  it("starts empty and stale", () => {
    const store = new SessionStore();
    expect(store.getAccessToken()).toBeNull();
    expect(store.getSnapshot()).toBeNull();
    expect(store.isStale()).toBe(true);
  });

  it("derives the snapshot from the token", () => {
    const store = new SessionStore();
    store.set(token(CLAIMS));
    expect(store.getSnapshot()?.workspaceId).toBe("01JWORKSPACE");
    expect(store.getAccessToken()).toContain(".");
  });

  it("counts a token expiring inside the skew window as stale", () => {
    const store = new SessionStore();
    const expiresAt = CLAIMS.exp * 1000;
    store.set(token(CLAIMS));
    expect(store.isStale(expiresAt - REFRESH_SKEW_MS - 1)).toBe(false);
    expect(store.isStale(expiresAt - REFRESH_SKEW_MS)).toBe(true);
    expect(store.isStale(expiresAt + 1)).toBe(true);
  });

  it("notifies subscribers on set and clear, and stops after unsubscribe", () => {
    const store = new SessionStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(token(CLAIMS));
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "01JWORKSPACE" }),
    );

    store.clear();
    expect(listener).toHaveBeenLastCalledWith(null);
    expect(store.getAccessToken()).toBeNull();

    unsubscribe();
    store.set(token(CLAIMS));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
