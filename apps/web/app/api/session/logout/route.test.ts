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

function signOutRequest(): Request {
  return new Request("https://aksharo.ai/api/session/logout", {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  });
}

afterEach(() => {
  cookieStore.value = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/session/logout", () => {
  /**
   * The whole point of the route: the page cannot read the httpOnly refresh
   * token, so the sign-out button used to send an empty string, which the API
   * rejects — leaving the family live for 30 days after the user believed they
   * had signed out (P0-06).
   */
  it("revokes the family with the real token from the cookie", async () => {
    cookieStore.value = REFRESH_TOKEN;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(signOutRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/auth\/logout$/);
    const body = JSON.parse((init as RequestInit).body as string) as { refreshToken: string };
    expect(body.refreshToken).toBe(REFRESH_TOKEN);
  });

  it("drops the cookie on the way out", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const response = await POST(signOutRequest());
    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
  });

  it("still drops the cookie when the API cannot be reached, and says so", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const response = await POST(signOutRequest());

    // Signed out of this browser; the caller is told the family may survive.
    expect(await response.json()).toEqual({ revoked: false });
    expect(response.cookies.get(SESSION_COOKIE)?.maxAge).toBe(0);
  });

  it("reports an API rejection rather than claiming a clean sign-out", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));

    const response = await POST(signOutRequest());
    expect(await response.json()).toEqual({ revoked: false });
  });

  it("is a clean no-op when there is no cookie", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(signOutRequest());

    expect(await response.json()).toEqual({ revoked: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never caches the answer", async () => {
    cookieStore.value = REFRESH_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const response = await POST(signOutRequest());
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a cross-site request", async () => {
    cookieStore.value = REFRESH_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("https://aksharo.ai/api/session/logout", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
