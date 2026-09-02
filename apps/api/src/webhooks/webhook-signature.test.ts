import { createRequire , Module } from "node:module";

import { describe, expect, it } from "vitest";

import { NODE_VERIFY_SNIPPET } from "./webhook-doc-snippets.js";
import { signWebhookPayload, verifyWebhookSignature } from "./webhook-signature.js";

/**
 * Executes {@link NODE_VERIFY_SNIPPET} — the exact text `/developers` renders
 * under "Verify a webhook" — as a real CommonJS module, so this test proves the
 * doc snippet, not a paraphrase of it, agrees with
 * {@link verifyWebhookSignature}. Acceptance criterion 2 of the B14 brief.
 */
function loadDocSnippet(): { verifyAksharoSignature: (...args: unknown[]) => boolean } {
  const mod = new Module("doc-snippet");
  // `process.cwd()` rather than `import.meta.url`: the snippet only ever
  // `require`s a Node builtin ("node:crypto"), which resolves the same from
  // any base path, and this keeps the file buildable as CommonJS too.
  mod.require = createRequire(`${process.cwd()}/`);
   
  (mod as any)._compile(NODE_VERIFY_SNIPPET, "doc-snippet.js");
  return mod.exports as { verifyAksharoSignature: (...args: unknown[]) => boolean };
}

describe("webhook signature — doc snippet parity", () => {
  it("the rendered Node verification snippet accepts what signWebhookPayload produces", () => {
    const { verifyAksharoSignature } = loadDocSnippet();
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ event: "export.completed", data: { exportId: "exp-1" } });
    const { header } = signWebhookPayload(secret, body);

    expect(verifyAksharoSignature(secret, body, header)).toBe(true);
    expect(verifyAksharoSignature(secret, body, header)).toBe(
      verifyWebhookSignature(secret, body, header),
    );
  });

  it("the doc snippet rejects a tampered body exactly like the implementation does", () => {
    const { verifyAksharoSignature } = loadDocSnippet();
    const secret = "whsec_test_secret";
    const body = JSON.stringify({ event: "job.failed" });
    const { header } = signWebhookPayload(secret, body);

    expect(verifyAksharoSignature(secret, body + "x", header)).toBe(false);
    expect(verifyWebhookSignature(secret, body + "x", header)).toBe(false);
  });
});

describe("signWebhookPayload / verifyWebhookSignature", () => {
  it("round-trips: what is signed verifies", () => {
    const secret = "s3cr3t";
    const body = '{"a":1}';
    const { header } = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, header)).toBe(true);
  });

  it("refuses the wrong secret", () => {
    const body = "{}";
    const { header } = signWebhookPayload("secret-a", body);
    expect(verifyWebhookSignature("secret-b", body, header)).toBe(false);
  });

  it("refuses a tampered body", () => {
    const secret = "s3cr3t";
    const { header } = signWebhookPayload(secret, "original");
    expect(verifyWebhookSignature(secret, "tampered", header)).toBe(false);
  });

  it("refuses a timestamp outside tolerance (replay protection)", () => {
    const secret = "s3cr3t";
    const body = "{}";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 10_000;
    const { header } = signWebhookPayload(secret, body, staleTimestamp);
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, Infinity)).toBe(true);
  });

  it("refuses a header missing either field", () => {
    expect(verifyWebhookSignature("s", "{}", "t=123")).toBe(false);
    expect(verifyWebhookSignature("s", "{}", "v1=abc")).toBe(false);
    expect(verifyWebhookSignature("s", "{}", "garbage")).toBe(false);
  });
});
