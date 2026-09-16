import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE } from "@/lib/session/cookie";

const cookieStore = { value: undefined as string | undefined };

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === SESSION_COOKIE && cookieStore.value !== undefined
          ? { name, value: cookieStore.value }
          : undefined,
    }),
}));

const { POST } = await import("./route");

const REFRESH_TOKEN = "refresh-token-value-long-enough";

function refreshRequest(): Request {
  return new Request("https://aksharo.ai/api/session/refresh", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  });
}

afterEach(() => {
  cookieStore.value = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/session/refresh", () => {
  it("rotates the cookie on a real success", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ accessToken: "new-access", refreshToken: "new-refresh" }), {
          status: 200,
        }),
      ),
    );

    const response = await POST(refreshRequest());

    expect(response.status).toBe(200);
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("new-refresh");
  });

  it("clears the cookie on a genuine 401 -- the token really is dead", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const response = await POST(refreshRequest());

    expect(response.status).toBe(401);
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  /**
   * The bug this pins down: this route used to clear the cookie on ANY
   * non-2xx from upstream, not just a real 401. A concurrent burst of tabs
   * refreshing at once trips this route's own rate limit (`auth:refresh:ip`,
   * `apps/api/src/auth/auth.constants.ts`) with a 429 that says nothing about
   * whether the token is still good -- yet it destroyed a live 30-day session
   * over one rate-limited round trip. Confirmed live: the affected session
   * row had no `revokedAt` and an `expiresAt` weeks out.
   */
  it("keeps the cookie on a 429 from the refresh rate limit -- not proof the token is dead", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 429 })));

    const response = await POST(refreshRequest());

    expect(response.status).toBe(503);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("keeps the cookie on a 5xx from upstream (a blip, or the API mid-restart)", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    const response = await POST(refreshRequest());

    expect(response.status).toBe(503);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("keeps the cookie when the API cannot be reached at all", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const response = await POST(refreshRequest());

    expect(response.status).toBe(503);
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("answers auth/expired without touching fetch when there is no cookie at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(refreshRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "auth/expired", message: "You are signed out." },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    cookieStore.value = REFRESH_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("https://aksharo.ai/api/session/refresh", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
