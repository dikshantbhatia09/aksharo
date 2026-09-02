import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";
import { RenderManifestError } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";

import { ManifestSignerService } from "./manifest-signer.js";

function envWith(secret: string, secretNext?: string): Env {
  return { INTERNAL_CALLBACK_SECRET: secret, INTERNAL_CALLBACK_SECRET_NEXT: secretNext } as Env;
}

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
/** `fixtureManifest`'s own default `issuedAt`; verification needs a clock near it. */
const FIXTURE_NOW = Date.parse("2026-09-02T09:00:00.000Z");

describe("ManifestSignerService", () => {
  it("signs a manifest and verifies it back", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    const manifest = fixtureManifest();
    const signed = signer.sign(manifest);
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);

    const verified = signer.verify(signed as unknown, FIXTURE_NOW + 1_000);
    expect(verified.manifestId).toBe(manifest.manifestId);
  });

  it("refuses a manifest with a flipped signature byte (THREAT-MODEL T10)", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    const signed = signer.sign(fixtureManifest());
    const tampered = { ...signed, signature: flipHexChar(signed.signature) };

    expect(() => signer.verify(tampered as unknown)).toThrowError(RenderManifestError);
    try {
      signer.verify(tampered as unknown);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderManifestError);
      expect((error as RenderManifestError).code).toBe("manifest/bad-signature");
    }
  });

  it("refuses a manifest whose watermark was edited after signing — the field the signature exists to protect", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    const signed = signer.sign(
      fixtureManifest({
        watermark: { assetId: "aksharo-watermark", position: "bottom-right", opacity: 0.85 },
      }),
    );
    // An attacker who could edit the payload without invalidating the signature
    // would strip the watermark and bypass the Free-tier mark entirely.
    const tampered = { ...signed, watermark: null };

    expect(() => signer.verify(tampered as unknown)).toThrow(RenderManifestError);
  });

  it("refuses a manifest signed under a different key entirely", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    const forger = new ManifestSignerService(envWith(OTHER_SECRET));
    const signed = forger.sign(fixtureManifest());

    expect(() => signer.verify(signed as unknown)).toThrow(RenderManifestError);
  });

  it("accepts a manifest signed with the primary during a rotation window", () => {
    const issuer = new ManifestSignerService(envWith(SECRET));
    const verifier = new ManifestSignerService(envWith(OTHER_SECRET, SECRET));
    const signed = issuer.sign(fixtureManifest());

    expect(() => verifier.verify(signed as unknown, FIXTURE_NOW + 1_000)).not.toThrow();
  });

  it("refuses an expired manifest", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    const now = Date.parse("2026-09-02T09:00:00.000Z");
    const signed = signer.sign(
      fixtureManifest({ expiresAt: new Date(now - 1_000).toISOString() }, now - 2 * 60 * 60_000),
    );

    try {
      signer.verify(signed as unknown, now);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderManifestError);
      expect((error as RenderManifestError).code).toBe("manifest/expired");
    }
  });

  it("refuses a malformed document", () => {
    const signer = new ManifestSignerService(envWith(SECRET));
    expect(() => signer.verify({ not: "a manifest" })).toThrow(RenderManifestError);
  });
});

function flipHexChar(hex: string): string {
  const flipped = hex[0] === "0" ? "1" : "0";
  return flipped + hex.slice(1);
}
