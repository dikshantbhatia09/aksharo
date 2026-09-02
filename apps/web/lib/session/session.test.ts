import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TokenResponse } from "@montaj/api-client";

import { clearSession, hasSessionCookie, persistSession, refreshSession } from "./client";
import {
  clearSessionCookie,
  isSameOrigin,
  isSecureRequest,
  SESSION_COOKIE,
  setSessionCookie,
} from "./cookie";

const TOKENS: TokenResponse = {
  accessToken: "access",
  refreshToken: "refresh-token-value-long-enough",
  expiresIn: 900,
  tokenType: "Bearer",
  sessionId: "01JSESSION",
  workspaceId: "01JWORKSPACE",
  role: "owner",
  kind: "web",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the session cookie (THREAT-MODEL T2)", () => {
  it("is httpOnly, SameSite=Lax and scoped to the whole site", () => {
    const response = new NextResponse(null, { status: 204 });
    setSessionCookie(response, "refresh", true);
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.path).toBe("/");
    // Families live 30 days from issue and are not extended by rotation.
    expect(cookie?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("clears by expiring rather than by deleting the value only", () => {
    const response = new NextResponse(null, { status: 204 });
    clearSessionCookie(response);
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });
});

describe("isSecureRequest", () => {
  it("follows the request scheme, not NODE_ENV", () => {
    // A production build served over plain http — a local end-to-end run, or a
    // pod behind a TLS-terminating proxy — must not set `Secure`, or WebKit
    // drops the cookie and the session silently never exists.
    expect(isSecureRequest(new Request("https://aksharo.ai/api/session"))).toBe(true);
    expect(isSecureRequest(new Request("http://127.0.0.1:3914/api/session"))).toBe(false);
  });

  it("trusts the edge's x-forwarded-proto when there is one", () => {
    const secure = new Request("http://api.internal/api/session", {
      headers: { "x-forwarded-proto": "https,http" },
    });
    expect(isSecureRequest(secure)).toBe(true);
    const plain = new Request("https://aksharo.ai/api/session", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(isSecureRequest(plain)).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("accepts a same-origin fetch and a direct navigation", () => {
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", {
          headers: { "sec-fetch-site": "same-origin" },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", { headers: { "sec-fetch-site": "none" } }),
      ),
    ).toBe(true);
  });

  it("rejects a cross-site post, which is how session fixation would arrive", () => {
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toBe(false);
  });

  it("falls back to Origin when the browser sends no Sec-Fetch-Site", () => {
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", {
          headers: { origin: "https://aksharo.ai" },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);
    expect(isSameOrigin(new Request("https://aksharo.ai/api/session"))).toBe(false);
    expect(
      isSameOrigin(
        new Request("https://aksharo.ai/api/session", { headers: { origin: "not a url" } }),
      ),
    ).toBe(false);
  });
});

describe("the browser session helpers", () => {
  it("hands the refresh token to this app's own origin, never to the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await persistSession(TOKENS);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string) as {
      refreshToken: string;
      accessToken?: string;
    };
    expect(body.refreshToken).toBe(TOKENS.refreshToken);
    // The access token stays in memory; it must not be written anywhere.
    expect(body.accessToken).toBeUndefined();
  });

  it("reports a failed store rather than pretending to be signed in", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(persistSession(TOKENS)).rejects.toThrow(/could not store/i);
  });

  it("swallows a failure when clearing: the cookie must go either way", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(clearSession()).resolves.toBeUndefined();
  });

  it("returns the fresh access token from a rotation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: "new",
            expiresIn: 900,
            workspaceId: "01JW",
            role: "owner",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: "new", expiresIn: 900 });
  });

  it("returns null for a revoked family, an unreachable server and a broken body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(refreshSession()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(refreshSession()).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(refreshSession()).resolves.toBeNull();
  });

  it("asks whether a cookie exists without ever reading it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(hasSessionCookie()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/session", { method: "GET" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await expect(hasSessionCookie()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(hasSessionCookie()).resolves.toBe(false);
  });
});
