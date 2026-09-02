import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { ACCESS_TOKEN_TTL_SEC } from "./auth.constants.js";
import { TokenService } from "./token.service.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
}

const KEYS = keyPair();

function service(overrides: Partial<Env> = {}): TokenService {
  return new TokenService({
    JWT_PRIVATE_KEY: KEYS.privateKey,
    JWT_PUBLIC_KEY: KEYS.publicKey,
    API_ORIGIN: "http://localhost:3001",
    ...overrides,
  } as unknown as Env);
}

const SUBJECT = {
  userId: "01J0000000000000000000USER",
  workspaceId: "01J000000000000000000000WS",
  role: "owner",
  kind: "web",
} as const;

/** Re-sign a tampered payload is impossible without the key; this only re-encodes. */
function reencode(token: string, mutate: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(claims);
  const next = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${header}.${next}.${signature}`;
}

describe("TokenService", () => {
  it("mints exactly the CONTRACTS section 5 claims, plus the issuer", () => {
    const minted = service().mintAccessToken(SUBJECT);
    expect(Object.keys(minted.claims).sort()).toEqual([
      "exp",
      "iat",
      "iss",
      "jti",
      "kind",
      "role",
      "sub",
      "ws",
    ]);
    expect(minted.expiresIn).toBe(ACCESS_TOKEN_TTL_SEC);
    expect(minted.claims.exp - minted.claims.iat).toBe(ACCESS_TOKEN_TTL_SEC);
    expect(minted.claims.sub).toBe(SUBJECT.userId);
    expect(minted.claims.ws).toBe(SUBJECT.workspaceId);
  });

  it("uses RS256 and round-trips", async () => {
    const tokens = service();
    const minted = tokens.mintAccessToken(SUBJECT);
    const header = JSON.parse(
      Buffer.from(minted.accessToken.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    await expect(tokens.verifyAccessToken(minted.accessToken)).resolves.toMatchObject({
      sub: SUBJECT.userId,
    });
  });

  it("honours a caller-supplied jti, so a token names its session", () => {
    const minted = service().mintAccessToken({ ...SUBJECT, jti: "01JSESSION0000000000000000" });
    expect(minted.jti).toBe("01JSESSION0000000000000000");
    expect(minted.claims.jti).toBe("01JSESSION0000000000000000");
  });

  it("rejects a token signed with a different key", async () => {
    const other = keyPair();
    const foreign = new TokenService({
      JWT_PRIVATE_KEY: other.privateKey,
      JWT_PUBLIC_KEY: other.publicKey,
      API_ORIGIN: "http://localhost:3001",
    } as unknown as Env);

    const minted = foreign.mintAccessToken(SUBJECT);
    await expect(service().verifyAccessToken(minted.accessToken)).rejects.toMatchObject({
      code: "common/unauthorized",
    });
  });

  it("rejects `alg: none` and an HMAC header before it looks at the signature", async () => {
    const tokens = service();
    const claims = { sub: "x", ws: "y", role: "owner", kind: "web", jti: "j", iat: 1, exp: 9e9 };
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

    for (const alg of ["none", "HS256", "RS512"]) {
      const forged = `${encode({ alg, typ: "JWT" })}.${encode(claims)}.`;
      await expect(tokens.verifyAccessToken(forged)).rejects.toMatchObject({
        code: "common/unauthorized",
      });
    }
  });

  it("rejects a tampered payload", async () => {
    const tokens = service();
    const minted = tokens.mintAccessToken(SUBJECT);
    const tampered = reencode(minted.accessToken, (claims) => {
      claims["ws"] = "01JSOMEONEELSESWORKSPACE00";
    });
    await expect(tokens.verifyAccessToken(tampered)).rejects.toMatchObject({
      code: "common/unauthorized",
    });
  });

  it("rejects a token from another issuer", async () => {
    const other = new TokenService({
      JWT_PRIVATE_KEY: KEYS.privateKey,
      JWT_PUBLIC_KEY: KEYS.publicKey,
      API_ORIGIN: "https://staging.example",
    } as unknown as Env);
    const minted = other.mintAccessToken(SUBJECT);
    await expect(service().verifyAccessToken(minted.accessToken)).rejects.toMatchObject({
      code: "common/unauthorized",
    });
  });

  it("reports an expired token as auth/expired so the client refreshes", async () => {
    const tokens = service();
    const minted = tokens.mintAccessToken(SUBJECT);
    // Sign a genuinely expired token by minting one in the past.
    const past = new Date(Date.now() - (ACCESS_TOKEN_TTL_SEC + 60) * 1000);
    const original = Date.now;
    Date.now = () => past.getTime();
    const stale = tokens.mintAccessToken(SUBJECT);
    Date.now = original;

    await expect(tokens.verifyAccessToken(stale.accessToken)).rejects.toMatchObject({
      code: "auth/expired",
    });
    await expect(tokens.verifyAccessToken(minted.accessToken)).resolves.toBeDefined();
  });

  it("rejects structurally invalid tokens", async () => {
    const tokens = service();
    for (const candidate of ["", "a.b", "a.b.c.d", "!!!.!!!.!!!"]) {
      await expect(tokens.verifyAccessToken(candidate)).rejects.toMatchObject({
        code: "common/unauthorized",
      });
    }
  });

  it("rejects a signed token whose claims do not match the contract", async () => {
    const tokens = service();
    const minted = tokens.mintAccessToken(SUBJECT);
    // Same signature, different claims: the signature check fails first, which is
    // the point - there is no path that accepts a claim set we did not sign.
    const broken = reencode(minted.accessToken, (claims) => {
      delete claims["role"];
    });
    await expect(tokens.verifyAccessToken(broken)).rejects.toMatchObject({
      code: "common/unauthorized",
    });
  });

  // -------------------------------------------------------------------------
  // B08b: `kind:"bridge"` tokens carry `deviceId` (CONTRACTS §5, amended
  // 2026-09-03 after C01).
  // -------------------------------------------------------------------------

  it("refuses to mint a bridge token without a deviceId", () => {
    const tokens = service();
    expect(() => tokens.mintAccessToken({ ...SUBJECT, kind: "bridge" })).toThrow(/deviceId/);
  });

  it("mints a bridge token carrying deviceId, and verifies it back", async () => {
    const tokens = service();
    const minted = tokens.mintAccessToken({
      ...SUBJECT,
      kind: "bridge",
      deviceId: "01J0000000000000000DEVICE",
    });
    expect(minted.claims.deviceId).toBe("01J0000000000000000DEVICE");
    const verified = await tokens.verifyAccessToken(minted.accessToken);
    expect(verified.deviceId).toBe("01J0000000000000000DEVICE");
  });

  it("never carries deviceId for any other kind, even if one is (incorrectly) passed", () => {
    const tokens = service();
    const minted = tokens.mintAccessToken({
      ...SUBJECT,
      kind: "web",
      deviceId: "01J0000000000000000DEVICE",
    });
    expect(minted.claims.deviceId).toBeUndefined();
  });
});
