import { createHash, createHmac, createSign, createVerify } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { ENV } from "../config/config.module.js";

/**
 * PDF digital signature (brief §3): "a PAdES-style detached signature over the
 * PDF hash with a configurable key, visible 'digitally signed' block".
 *
 * "Detached" here means literally that: the signature is a small JSON record
 * (algorithm, key id, base64 signature, the SHA-256 hash it was taken over,
 * timestamp) stored **next to** the PDF in derived storage
 * (`invoices.signatureKey`), rather than embedded as a real PAdES incremental
 * PDF update — `pdfkit` has no PAdES/CMS support and adding one is out of this
 * work package's scope. The PDF itself carries a human-readable "Digitally
 * signed" block (name, signature id, timestamp) so a reader sees the claim; the
 * detached record is what a verifier actually checks it against.
 *
 * **Key configuration, and a documented deviation.** `docs/CONTRACTS.md` (this
 * work package's setup rules: "never modify docs/CONTRACTS.md") freezes the
 * `.env.example`/environment-variable contract, so no new *required* secret was
 * added there. `INTERNAL_CALLBACK_SECRET` — already required, already a
 * 32+-byte random secret used for HMAC (CONTRACTS §3) — is the default signing
 * key; deployments that want a dedicated key can set the optional,
 * non-contract `INVOICE_SIGNING_KEY` environment variable (either an HMAC
 * passphrase or an RSA private key PEM), read directly from `process.env`
 * rather than through the frozen `Env` schema. Documented as a deviation in the
 * work package report.
 */

export interface InvoiceSignatureRecord {
  readonly algorithm: "hmac-sha256" | "rsa-sha256";
  readonly keyId: string;
  /** Base64. */
  readonly signature: string;
  /** Hex SHA-256 of the PDF bytes the signature was taken over. */
  readonly pdfSha256: string;
  readonly signedAt: string;
  readonly signerName: string;
}

@Injectable()
export class InvoiceSignatureService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  sign(pdfBytes: Uint8Array, signerName: string): InvoiceSignatureRecord {
    const hash = createHash("sha256").update(pdfBytes).digest();
    const pdfSha256 = hash.toString("hex");
    const signedAt = new Date().toISOString();
    const configuredKey = process.env["INVOICE_SIGNING_KEY"]?.trim();

    if (configuredKey !== undefined && configuredKey.includes("BEGIN")) {
      const signer = createSign("RSA-SHA256");
      signer.update(hash);
      signer.end();
      return {
        algorithm: "rsa-sha256",
        keyId: "invoice_signing_key",
        signature: signer.sign(configuredKey.replace(/\\n/g, "\n"), "base64"),
        pdfSha256,
        signedAt,
        signerName,
      };
    }

    const hmacKey =
      configuredKey !== undefined && configuredKey !== ""
        ? configuredKey
        : this.env.INTERNAL_CALLBACK_SECRET;
    const signature = createHmac("sha256", hmacKey).update(hash).digest("base64");
    return {
      algorithm: "hmac-sha256",
      keyId:
        configuredKey !== undefined && configuredKey !== ""
          ? "invoice_signing_key"
          : "internal_callback_secret",
      signature,
      pdfSha256,
      signedAt,
      signerName,
    };
  }

  /** Recomputes the PDF hash and checks it against the record's own hash and signature. */
  verify(pdfBytes: Uint8Array, record: InvoiceSignatureRecord): boolean {
    const hash = createHash("sha256").update(pdfBytes).digest();
    if (hash.toString("hex") !== record.pdfSha256) return false;

    if (record.algorithm === "rsa-sha256") {
      const configuredKey = process.env["INVOICE_SIGNING_KEY"]?.trim();
      if (configuredKey === undefined || !configuredKey.includes("BEGIN")) return false;
      const verifier = createVerify("RSA-SHA256");
      verifier.update(hash);
      verifier.end();
      // Verification needs the public key; a PEM private key also lets Node
      // derive the public half for this check.
      try {
        return verifier.verify(configuredKey.replace(/\\n/g, "\n"), record.signature, "base64");
      } catch {
        return false;
      }
    }

    const configuredKey = process.env["INVOICE_SIGNING_KEY"]?.trim();
    const hmacKey =
      configuredKey !== undefined && configuredKey !== ""
        ? configuredKey
        : this.env.INTERNAL_CALLBACK_SECRET;
    const expected = createHmac("sha256", hmacKey).update(hash).digest("base64");
    return expected === record.signature;
  }
}
