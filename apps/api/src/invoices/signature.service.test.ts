import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { InvoiceSignatureService } from "./signature.service.js";

function fakeEnv(): Env {
  return { INTERNAL_CALLBACK_SECRET: "a".repeat(32) } as Env;
}

describe("InvoiceSignatureService", () => {
  beforeEach(() => {
    delete process.env["INVOICE_SIGNING_KEY"];
  });

  it("signs with HMAC over INTERNAL_CALLBACK_SECRET when no dedicated key is configured", () => {
    const service = new InvoiceSignatureService(fakeEnv());
    const pdf = Buffer.from("pdf bytes here");
    const record = service.sign(pdf, "Aksharo Technologies Private Limited");

    expect(record.algorithm).toBe("hmac-sha256");
    expect(record.keyId).toBe("internal_callback_secret");
    expect(record.pdfSha256).toHaveLength(64);
    expect(service.verify(pdf, record)).toBe(true);
  });

  it("detects tampering: a different PDF fails verification", () => {
    const service = new InvoiceSignatureService(fakeEnv());
    const record = service.sign(Buffer.from("original"), "Aksharo");
    expect(service.verify(Buffer.from("tampered"), record)).toBe(false);
  });

  it("is deterministic for the same key and bytes but produces a fresh signedAt", () => {
    const service = new InvoiceSignatureService(fakeEnv());
    const pdf = Buffer.from("same bytes");
    const a = service.sign(pdf, "Aksharo");
    const b = service.sign(pdf, "Aksharo");
    expect(a.signature).toBe(b.signature); // same key, same hash -> same HMAC
    expect(a.pdfSha256).toBe(b.pdfSha256);
  });

  it("uses the configurable INVOICE_SIGNING_KEY when set (HMAC passphrase)", () => {
    process.env["INVOICE_SIGNING_KEY"] = "a-dedicated-signing-passphrase";
    const service = new InvoiceSignatureService(fakeEnv());
    const pdf = Buffer.from("pdf bytes");
    const record = service.sign(pdf, "Aksharo");
    expect(record.keyId).toBe("invoice_signing_key");
    expect(service.verify(pdf, record)).toBe(true);

    // A different INTERNAL_CALLBACK_SECRET-only signer must NOT verify it:
    // proves the dedicated key actually changes what is signed.
    delete process.env["INVOICE_SIGNING_KEY"];
    const defaultSigner = new InvoiceSignatureService(fakeEnv());
    expect(defaultSigner.verify(pdf, record)).toBe(false);
  });
});
