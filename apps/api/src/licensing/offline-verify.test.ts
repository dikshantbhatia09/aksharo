import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { verifyOfflineSnapshot } from "./offline-verify.js";
import { SigningService } from "./signing.service.js";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}

function fakeSigner(privateKey: string, publicKey: string, kid = "test-kid"): SigningService {
  const env = {
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    LICENSE_SIGNING_KID: kid,
  } as Env;
  return new SigningService(env);
}

const HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS;

function samplePayload(issuedAt: Date) {
  return {
    workspaceId: "01WORKSPACE0000000000000",
    deviceId: "01DEVICE00000000000000000",
    plan: { key: "agency", name: "Agency" },
    activationLimit: 3,
    issuedAt: issuedAt.toISOString(),
    exp: new Date(issuedAt.getTime() + SEVEN_DAYS_MS).toISOString(),
    kid: "test-kid",
    revocationSerial: 0,
  };
}

describe("licensing offline verification (05 section 8, THREAT-MODEL T15)", () => {
  it("verifies a snapshot signed by the matching key, within the 7-day window", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const now = new Date();
    const token = signing.sign(samplePayload(now));

    const result = verifyOfflineSnapshot(token, publicKey, now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.workspaceId).toBe("01WORKSPACE0000000000000");
      expect(result.payload.kid).toBe("test-kid");
    }
  });

  it("is still valid 6 days 23 hours after issuance (inside the 7-day offline window)", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const issuedAt = new Date();
    const token = signing.sign(samplePayload(issuedAt));

    const almostSevenDaysLater = new Date(issuedAt.getTime() + SEVEN_DAYS_MS - HOUR_MS);
    const result = verifyOfflineSnapshot(token, publicKey, almostSevenDaysLater);
    expect(result.ok).toBe(true);
  });

  it("fails once the 7-day offline window has passed", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const issuedAt = new Date();
    const token = signing.sign(samplePayload(issuedAt));

    const eightDaysLater = new Date(issuedAt.getTime() + SEVEN_DAYS_MS + 24 * HOUR_MS);
    const result = verifyOfflineSnapshot(token, publicKey, eightDaysLater);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("tolerates up to 5 minutes of clock skew past the exact expiry instant", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const issuedAt = new Date();
    const token = signing.sign(samplePayload(issuedAt));

    const exp = new Date(issuedAt.getTime() + SEVEN_DAYS_MS);
    const justInsideSkew = new Date(exp.getTime() + 4 * 60 * 1000);
    expect(verifyOfflineSnapshot(token, publicKey, justInsideSkew).ok).toBe(true);

    const justOutsideSkew = new Date(exp.getTime() + 6 * 60 * 1000);
    expect(verifyOfflineSnapshot(token, publicKey, justOutsideSkew).ok).toBe(false);
  });

  it("rejects a signature from the wrong key pair", () => {
    const signer = keyPair();
    const impostor = keyPair();
    const signing = fakeSigner(signer.privateKey, signer.publicKey);
    const token = signing.sign(samplePayload(new Date()));

    const result = verifyOfflineSnapshot(token, impostor.publicKey, new Date());
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload (signature no longer covers the modified bytes)", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const token = signing.sign(samplePayload(new Date()));
    const [header, payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...samplePayload(new Date()), activationLimit: 999 }),
      "utf8",
    ).toString("base64url");
    const tampered = `${header}.${tamperedPayload}.${signature}`;

    const result = verifyOfflineSnapshot(tampered, publicKey, new Date());
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    void payload;
  });

  it("rejects alg: none / a non-RS256 header before checking any signature", () => {
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: "AKLIC" }),
      "utf8",
    ).toString("base64url");
    const forgedPayload = Buffer.from(JSON.stringify(samplePayload(new Date())), "utf8").toString(
      "base64url",
    );
    const forged = `${forgedHeader}.${forgedPayload}.`;

    const result = verifyOfflineSnapshot(forged, keyPair().publicKey, new Date());
    expect(result).toEqual({ ok: false, reason: "bad_algorithm" });
  });

  it("rejects garbage input", () => {
    const result = verifyOfflineSnapshot("not-a-token", keyPair().publicKey, new Date());
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("SigningService (kid, round trip)", () => {
  it("embeds the configured kid in the header", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey, "k2026-09");
    expect(signing.kid).toBe("k2026-09");

    const token = signing.sign({ hello: "world" });
    const decodedHeader = JSON.parse(
      Buffer.from(token.split(".")[0] as string, "base64url").toString("utf8"),
    ) as { kid: string; alg: string };
    expect(decodedHeader.kid).toBe("k2026-09");
    expect(decodedHeader.alg).toBe("RS256");
  });

  it("verify() round-trips what sign() produced", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const token = signing.sign({ a: 1, b: "two" });

    const verified = signing.verify<{ a: number; b: string }>(token);
    expect(verified?.payload).toEqual({ a: 1, b: "two" });
  });

  it("verify() returns null for a corrupted token", () => {
    const { privateKey, publicKey } = keyPair();
    const signing = fakeSigner(privateKey, publicKey);
    const token = signing.sign({ a: 1 });
    const corrupted = `${token.slice(0, -4)}AAAA`;
    expect(signing.verify(corrupted)).toBeNull();
  });
});
