import { describe, expect, it, vi } from "vitest";

import { endpoints } from "./endpoints.js";
import { ApiError, AUTH_ERROR_CODES, CLIENT_ERROR_CODES } from "./errors.js";
import { createApiClient, defineEndpoint } from "./http.js";

const BASE = "https://api.test";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function envelope(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { error: { code, message, requestId: "01JREQ", ...extra } };
}

describe("ApiClient", () => {
  it("builds the URL from the path template and the query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "approved" }));
    const client = createApiClient({ baseUrl: `${BASE}/`, fetch: fetchMock });

    await client.call(endpoints.device.describe, {
      params: { userCode: "4F7K92QA" },
      query: { verbose: true, skip: undefined },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/auth/device/code/4F7K92QA?verbose=true`);
  });

  it("percent-encodes a path parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    await client.call(endpoints.auth.revokeSession, { params: { sessionId: "a/b c" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/auth/sessions/a%2Fb%20c`);
  });

  it("refuses to build a URL with a missing path parameter", async () => {
    const client = createApiClient({ baseUrl: BASE, fetch: vi.fn() });
    await expect(client.call(endpoints.auth.revokeSession)).rejects.toThrow(
      /missing path parameter "sessionId"/,
    );
  });

  it("sends the bearer token only on authenticated routes and never a cookie", async () => {
    // A `Response` body can be read once, so each call needs its own instance.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    await client.call(endpoints.auth.listSessions);
    const authed = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((authed.headers as Record<string, string>)["Authorization"]).toBe("Bearer access-token");
    expect(authed.credentials).toBe("omit");

    await client.call(endpoints.auth.login, { body: { email: "a@b.co", password: "x" } });
    const publicCall = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((publicCall.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("returns undefined for a 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    await expect(
      client.call(endpoints.auth.logout, { body: { refreshToken: "r" } }),
    ).resolves.toBeUndefined();
  });

  it("turns the error envelope into an ApiError with its code and requestId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(envelope(AUTH_ERROR_CODES.invalidCredentials, "That did not work."), {
        status: 401,
      }),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });

    await expect(
      client.call(endpoints.auth.login, { body: { email: "a@b.co", password: "x" } }),
    ).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.invalidCredentials,
      status: 401,
      requestId: "01JREQ",
    });
  });

  it("reads Retry-After off a 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(envelope("common/rate_limited", "Too many attempts."), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "45" },
      }),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = await client
      .call(endpoints.auth.requestMagicLink, { body: { email: "a@b.co" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryAfterMs).toBe(45_000);
    expect((error as ApiError).isRetryable).toBe(true);
  });

  it("exposes requiredPlan from an entitlement envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        envelope("entitlement/upgrade_required", "Creator is needed for this.", {
          details: { requiredPlan: "creator" },
        }),
        { status: 402 },
      ),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = (await client
      .call(endpoints.auth.listSessions)
      .catch((c: unknown) => c)) as ApiError;
    expect(error.requiredPlan).toBe("creator");
  });

  it("reports an unreachable server rather than throwing a TypeError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = (await client
      .call(endpoints.auth.listSessions)
      .catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.networkUnreachable);
    expect(error.message).toMatch(/check your connection/i);
  });

  it("reports an abort distinctly, so a cancelled navigation is not an outage", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = (await client
      .call(endpoints.auth.listSessions)
      .catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.aborted);
  });

  it("flags a response that is not the contract envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = (await client
      .call(endpoints.auth.listSessions)
      .catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.malformedResponse);
    expect(error.status).toBe(502);
  });

  it("raises client/not_implemented for a route whose work package has not landed", async () => {
    const fetchMock = vi.fn();
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock });
    const error = (await client.call(endpoints.pending.usage).catch((c: unknown) => c)) as ApiError;
    expect(error.code).toBe(CLIENT_ERROR_CODES.notImplemented);
    expect(error.message).toContain("B02");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("silent refresh (CONTRACTS §5)", () => {
  const protectedEndpoint = defineEndpoint<void, { ok: boolean }>({
    method: "GET",
    path: "/auth/sessions",
    auth: "bearer",
    operationId: "AuthController_listSessions",
  });

  it("rotates once on a 401 and replays the request with the new token", async () => {
    let token = "old";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(envelope(AUTH_ERROR_CODES.expired, "Expired."), { status: 401 }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const refresh = vi.fn().mockImplementation(async () => {
      token = "new";
      return token;
    });

    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => token,
      refreshAccessToken: refresh,
      fetch: fetchMock,
    });

    await expect(client.call(protectedEndpoint)).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledOnce();
    const retried = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((retried.headers as Record<string, string>)["Authorization"]).toBe("Bearer new");
  });

  it("collapses concurrent 401s into a single rotation", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)["Authorization"];
      return Promise.resolve(
        auth === "Bearer new"
          ? jsonResponse({ ok: true })
          : jsonResponse(envelope(AUTH_ERROR_CODES.expired, "Expired."), { status: 401 }),
      );
    });
    let token = "old";
    const refresh = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      token = "new";
      return token;
    });
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => token,
      refreshAccessToken: refresh,
      fetch: fetchMock,
    });

    await Promise.all([
      client.call(protectedEndpoint),
      client.call(protectedEndpoint),
      client.call(protectedEndpoint),
    ]);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("signs the user out when the family is revoked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(envelope(AUTH_ERROR_CODES.expired, "Expired."), { status: 401 }),
      );
    const onUnauthenticated = vi.fn();
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => "old",
      refreshAccessToken: vi.fn().mockResolvedValue(null),
      onUnauthenticated,
      fetch: fetchMock,
    });

    await expect(client.call(protectedEndpoint)).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthenticated).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not loop when the replay is also rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(envelope(AUTH_ERROR_CODES.expired, "Expired."), { status: 401 }),
      );
    const refresh = vi.fn().mockResolvedValue("new");
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => "old",
      refreshAccessToken: refresh,
      fetch: fetchMock,
    });

    await expect(client.call(protectedEndpoint)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("realtimeUrl", () => {
  it("switches the scheme and keeps the host", () => {
    expect(createApiClient({ baseUrl: "https://api.aksharo.ai" }).realtimeUrl).toBe(
      "wss://api.aksharo.ai/realtime",
    );
    expect(createApiClient({ baseUrl: "http://127.0.0.1:3913/" }).realtimeUrl).toBe(
      "ws://127.0.0.1:3913/realtime",
    );
  });
});

describe("a 401 from a public route", () => {
  it("is a domain answer, not an expired session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(envelope(AUTH_ERROR_CODES.invalidCredentials, "That did not work."), {
        status: 401,
      }),
    );
    const refresh = vi.fn();
    const onUnauthenticated = vi.fn();
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => "access",
      refreshAccessToken: refresh,
      onUnauthenticated,
      fetch: fetchMock,
    });

    // Signing in with the wrong password must not rotate the session and must
    // not bounce the user to `/login?reason=expired`.
    await expect(
      client.call(endpoints.auth.login, { body: { email: "a@b.co", password: "wrong" } }),
    ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidCredentials });

    expect(refresh).not.toHaveBeenCalled();
    expect(onUnauthenticated).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("ApiClient.callText", () => {
  const exportVtt = defineEndpoint<void, unknown>({
    method: "GET",
    path: "/projects/{projectId}/transcript/export",
    auth: "bearer",
  });
  const VTT = ["WEBVTT", "", "00:00:00.200 --> 00:00:01.300", "Its an editorial", ""].join("\n");

  // A transcript export is a file, not JSON; `call` would refuse it as malformed.
  it("returns a file body as text, with the bearer token, and asks for any type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } }));
    const client = createApiClient({ baseUrl: BASE, getAccessToken: () => "tok", fetch: fetchMock });

    await expect(
      client.callText(exportVtt, { params: { projectId: "01P" }, query: { format: "vtt" } }),
    ).resolves.toBe(VTT);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE}/projects/01P/transcript/export?format=vtt`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Accept"]).toBe("*/*");
  });

  it("still turns an error envelope into an ApiError", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(envelope("common/not_found", "No such project."), { status: 404 }));
    const client = createApiClient({ baseUrl: BASE, getAccessToken: () => "tok", fetch: fetchMock });
    const error = await client
      .callText(exportVtt, { params: { projectId: "01P" } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("common/not_found");
  });

  it("refreshes once on a 401 and retries as text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(envelope("auth/expired", "Expired."), { status: 401 }))
      .mockResolvedValueOnce(new Response(VTT, { status: 200 }));
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => "tok",
      refreshAccessToken: async () => "fresh",
      fetch: fetchMock,
    });
    await expect(client.callText(exportVtt, { params: { projectId: "01P" } })).resolves.toBe(VTT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
