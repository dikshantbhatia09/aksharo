import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  HttpGoogleOAuthProvider,
  parseIdToken,
} from "./google-oauth.provider.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";

function provider(overrides: Partial<Env> = {}): HttpGoogleOAuthProvider {
  return new HttpGoogleOAuthProvider({
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: "test-secret",
    ...overrides,
  } as unknown as Env);
}

/** An unsigned JWT: the token endpoint's reply is trusted, its signature is not read. */
function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const VALID_CLAIMS = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "1234567890",
  email: "Someone@Example.test",
  email_verified: true,
  name: "Someone",
  picture: "https://example.test/avatar.png",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseIdToken", () => {
  it("reads the claims this product stores", () => {
    expect(parseIdToken(idToken(VALID_CLAIMS), CLIENT_ID)).toEqual({
      subject: "1234567890",
      email: "someone@example.test",
      emailVerified: true,
      name: "Someone",
      picture: "https://example.test/avatar.png",
    });
  });

  it("accepts both issuer spellings Google uses", () => {
    expect(
      parseIdToken(idToken({ ...VALID_CLAIMS, iss: "accounts.google.com" }), CLIENT_ID).subject,
    ).toBe("1234567890");
  });

  it("rejects a token minted for a different client", () => {
    expect(() =>
      parseIdToken(idToken({ ...VALID_CLAIMS, aud: "someone-else" }), CLIENT_ID),
    ).toThrowError(expect.objectContaining({ code: "auth/provider_unavailable" }));
  });

  it("rejects an unexpected issuer", () => {
    expect(() =>
      parseIdToken(idToken({ ...VALID_CLAIMS, iss: "https://evil.test" }), CLIENT_ID),
    ).toThrowError(expect.objectContaining({ code: "auth/provider_unavailable" }));
  });

  it("rejects a token with no subject or no address", () => {
    for (const claims of [
      { ...VALID_CLAIMS, sub: "" },
      { ...VALID_CLAIMS, email: undefined },
    ]) {
      expect(() => parseIdToken(idToken(claims), CLIENT_ID)).toThrowError(
        expect.objectContaining({ code: "auth/provider_unavailable" }),
      );
    }
  });

  it("rejects a malformed token", () => {
    for (const candidate of ["not-a-token", "a.b", "a.!!!.c"]) {
      expect(() => parseIdToken(candidate, CLIENT_ID)).toThrowError(
        expect.objectContaining({ code: "auth/provider_unavailable" }),
      );
    }
  });

  it("treats an unverified address as unverified rather than absent", () => {
    const profile = parseIdToken(idToken({ ...VALID_CLAIMS, email_verified: false }), CLIENT_ID);
    expect(profile.emailVerified).toBe(false);
  });
});

describe("HttpGoogleOAuthProvider", () => {
  it("reports whether the credentials are configured", () => {
    expect(provider().configured).toBe(true);
    expect(provider({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }).configured).toBe(false);
  });

  it("builds an authorization URL with PKCE and no offline access", () => {
    const url = new URL(
      provider().authorizationUrl({
        state: "state-value",
        codeChallenge: "challenge-value",
        redirectUri: "http://localhost:3001/auth/oauth/google/callback",
        loginHint: "someone@example.test",
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "openid email profile",
      state: "state-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
      // Refresh tokens are Google's, not ours: the identity is needed once.
      access_type: "online",
      login_hint: "someone@example.test",
    });
  });

  it("refuses to start when the credentials are missing", () => {
    expect(() =>
      provider({ GOOGLE_OAUTH_CLIENT_ID: undefined }).authorizationUrl({
        state: "s",
        codeChallenge: "c",
        redirectUri: "http://localhost:3001/cb",
      }),
    ).toThrowError(expect.objectContaining({ code: "auth/provider_unavailable" }));
  });

  it("posts the verifier and the secret to the token endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id_token: idToken(VALID_CLAIMS) }), { status: 200 }),
      );

    const profile = await provider().exchangeCode({
      code: "auth-code",
      codeVerifier: "verifier-value",
      redirectUri: "http://localhost:3001/auth/oauth/google/callback",
    });

    expect(profile.subject).toBe("1234567890");
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=verifier-value");
  });

  it("turns a provider failure into auth/provider_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(
      provider().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://x/cb" }),
    ).rejects.toMatchObject({ code: "auth/provider_unavailable" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    await expect(
      provider().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://x/cb" }),
    ).rejects.toMatchObject({ code: "auth/provider_unavailable" });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "no-id-token" }), { status: 200 }),
    );
    await expect(
      provider().exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://x/cb" }),
    ).rejects.toMatchObject({ code: "auth/provider_unavailable" });
  });
});
