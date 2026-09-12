import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import * as React from "react";
import { vi } from "vitest";

import { ApiProvider, createApiClient, SessionStore } from "@montaj/api-client";
import { TooltipProvider } from "@montaj/ui";

import type { RuntimeConfig } from "@/lib/runtime-config";
import type { RenderResult } from "@testing-library/react";

import { RuntimeConfigTestProvider } from "@/components/providers";

/**
 * Mount a shell component with everything the real tree gives it.
 *
 * The API client is driven by an injected `fetch`, so a test says what the
 * server answered rather than mocking a hook; that keeps the tests honest about
 * the query keys, the error envelope and the `client/not_implemented` fallback.
 */

export const TEST_CONFIG: RuntimeConfig = {
  apiOrigin: "https://api.test",
  posthogKey: null,
  posthogHost: "https://posthog.test",
  sentryDsn: null,
  flags: {},
  environment: "test",
  googleOAuthEnabled: true,
  razorpayEnabled: true,
  authDevAutoVerify: false,
  webOrigin: "https://kalakar.io",
};

export interface HarnessOptions {
  /** Route → JSON body (or a full `Response`). Anything unlisted 404s. */
  routes?: Record<string, unknown>;
  /** Signed in by default; pass `null` for a signed-out tree. */
  accessToken?: string | null;
  config?: Partial<RuntimeConfig>;
}

/** A JWT with the CONTRACTS §5 claims. Not signed — nothing verifies it here. */
export function testAccessToken(
  claims: Partial<{ sub: string; ws: string; role: string; exp: number }> = {},
): string {
  const payload = {
    sub: "01JUSER",
    ws: "01JWORKSPACE",
    role: "owner",
    kind: "web",
    jti: "01JSESSION",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  };
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options: HarnessOptions = {},
): RenderResult & { fetchMock: ReturnType<typeof vi.fn>; session: SessionStore } {
  const routes = options.routes ?? {};

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const key = url.pathname;
    if (!(key in routes)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "common/not_found", message: "Not found." } }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const body = routes[key];
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  const session = new SessionStore();
  const token = options.accessToken === undefined ? testAccessToken() : options.accessToken;
  // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
  if (token !== null) session.set(token);

  const client = createApiClient({
    baseUrl: "https://api.test",
    getAccessToken: session.getAccessToken,
    fetch: fetchMock as unknown as typeof fetch,
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const config = { ...TEST_CONFIG, ...options.config };

  const result = render(
    <RuntimeConfigTestProvider value={config}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider value={{ client, session }}>
          <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
        </ApiProvider>
      </QueryClientProvider>
    </RuntimeConfigTestProvider>,
  );

  return { ...result, fetchMock, session };
}
