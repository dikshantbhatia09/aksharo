import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AccessTokenError,
  TOKEN_KINDS,
  extractBearer,
  safeEqual,
  verifyAccessToken,
} from "./access-token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM_PUBLIC = publicKey.export({ type: "spki", format: "pem" }).toString();

const OTHER = generateKeyPairSync("rsa", { modulusLength: 2048 });

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Mint an RS256 token, exactly the claim set of CONTRACTS §5. */
function mint(
  claims: Record<string, unknown> = {},
  options: { header?: Record<string, unknown>; key?: typeof privateKey } = {},
): string {
  const header = { alg: "RS256", typ: "JWT", ...(options.header ?? {}) };
  const payload = {
    sub: "01JCUSER00000000000000000A",
    ws: "01JCWS0000000000000000000A",
    role: "owner",
    kind: "web",
    jti: "01JCJTI000000000000000000A",
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 900,
    ...claims,
  };
  const signed = `${base64url(header)}.${base64url(payload)}`;
  if (header.alg === "none") return `${signed}.`;
  const signer = createSign("RSA-SHA256");
  signer.update(signed);
  signer.end();
  return `${signed}.${signer.sign(options.key ?? privateKey).toString("base64url")}`;
}

const verify = (token: string, now = NOW) =>
  verifyAccessToken(token, { publicKeyPem: PEM_PUBLIC, now: () => now });

describe("verifyAccessToken (CONTRACTS §5)", () => {
  it("returns the full claim set", () => {
    expect(verify(mint())).toEqual({
      sub: "01JCUSER00000000000000000A",
      ws: "01JCWS0000000000000000000A",
      role: "owner",
      kind: "web",
      jti: "01JCJTI000000000000000000A",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 900,
    });
  });

  it("accepts every client kind in the contract", () => {
    for (const kind of TOKEN_KINDS) expect(verify(mint({ kind })).kind).toBe(kind);
  });

  it("rejects a malformed token", () => {
    for (const token of ["", "a", "a.b", "a.b.c.d", "!!.??.??"]) {
      expect(() => verify(token)).toThrow(AccessTokenError);
    }
  });

  it("rejects alg:none — the classic JWT forgery", () => {
    const failure = catchError(() => verify(mint({}, { header: { alg: "none" } })));
    expect(failure.reason).toBe("algorithm");
  });

  it("rejects HS256, so the public key cannot be used as an HMAC secret", () => {
    const failure = catchError(() => verify(mint({}, { header: { alg: "HS256" } })));
    expect(failure.reason).toBe("algorithm");
  });

  it("rejects a token signed by another key", () => {
    const failure = catchError(() => verify(mint({}, { key: OTHER.privateKey })));
    expect(failure.reason).toBe("signature");
  });

  it("rejects a tampered payload", () => {
    const token = mint();
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = base64url({ sub: "attacker", ws: "someone-else" });
    expect(() => verify(`${header}.${forged}.${signature}`)).toThrow(AccessTokenError);
  });

  it("rejects an expired token, with a little tolerance for clock drift", () => {
    const token = mint();
    expect(() => verify(token, NOW + 900_000 + 20_000)).not.toThrow();
    expect(catchError(() => verify(token, NOW + 900_000 + 60_000)).reason).toBe("expired");
  });

  it("rejects a token issued in the future", () => {
    const token = mint({ iat: Math.floor(NOW / 1000) + 600 });
    expect(catchError(() => verify(token)).reason).toBe("claims");
  });

  it("requires every contract claim", () => {
    for (const missing of ["sub", "ws", "role", "kind", "jti", "iat", "exp"]) {
      const claims: Record<string, unknown> = {};
      claims[missing] = undefined;
      const token = mint(claims);
      expect(catchError(() => verify(token)).reason, missing).toBe("claims");
    }
  });

  it("rejects an unknown client kind", () => {
    expect(catchError(() => verify(mint({ kind: "toaster" }))).reason).toBe("claims");
  });

  it("rejects a token whose payload is not an object", () => {
    const header = base64url({ alg: "RS256", typ: "JWT" });
    const payload = Buffer.from(JSON.stringify([1, 2, 3]), "utf8").toString("base64url");
    expect(() => verify(`${header}.${payload}.x`)).toThrow(AccessTokenError);
  });
});

describe("extractBearer", () => {
  const bearerPrefix = "bearer.";

  it("reads an Authorization header", () => {
    expect(extractBearer({ authorization: "Bearer abc", bearerPrefix })).toBe("abc");
    expect(extractBearer({ authorization: "bearer abc", bearerPrefix })).toBe("abc");
  });

  it("reads the WebSocket subprotocol a browser can actually set", () => {
    expect(extractBearer({ subprotocols: ["aksharo.v1", "bearer.abc"], bearerPrefix })).toBe("abc");
  });

  it("prefers the header when both are present", () => {
    expect(
      extractBearer({
        authorization: "Bearer from-header",
        subprotocols: ["bearer.from-subprotocol"],
        bearerPrefix,
      }),
    ).toBe("from-header");
  });

  it("returns undefined when there is nothing to read", () => {
    expect(extractBearer({ bearerPrefix })).toBeUndefined();
    expect(extractBearer({ authorization: "Basic abc", bearerPrefix })).toBeUndefined();
    expect(extractBearer({ authorization: "Bearer   ", bearerPrefix })).toBeUndefined();
    expect(extractBearer({ subprotocols: ["aksharo.v1"], bearerPrefix })).toBeUndefined();
    expect(extractBearer({ subprotocols: ["bearer."], bearerPrefix })).toBeUndefined();
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal strings without throwing on length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

function catchError(fn: () => unknown): AccessTokenError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AccessTokenError) return error;
    throw error;
  }
  throw new Error("expected an AccessTokenError");
}
