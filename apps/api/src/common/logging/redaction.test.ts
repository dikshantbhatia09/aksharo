import { describe, expect, it } from "vitest";

import { maskEmail, REDACT_PATHS, REDACTED, redactLogObject, redactValue } from "./redaction.js";

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("dikshant@example.com")).toBe("d***@example.com");
  });

  it("masks every address in a sentence", () => {
    expect(maskEmail("invited a@x.io and bb@y.co.uk")).toBe("invited a***@x.io and b***@y.co.uk");
  });

  it("leaves text without an address alone", () => {
    expect(maskEmail("no address here")).toBe("no address here");
  });
});

describe("redactValue", () => {
  it("replaces the value of any secret-looking key", () => {
    const out = redactValue({
      password: "hunter2",
      passwordHash: "argon2id$...",
      accessToken: "eyJ...",
      apiKey: "sk_live_x",
      refreshToken: "opaque",
      INTERNAL_CALLBACK_SECRET: "abc",
      pan: "ABCDE1234F",
      title: "My reel",
    });

    expect(out).toEqual({
      password: REDACTED,
      passwordHash: REDACTED,
      accessToken: REDACTED,
      apiKey: REDACTED,
      refreshToken: REDACTED,
      INTERNAL_CALLBACK_SECRET: REDACTED,
      pan: REDACTED,
      title: "My reel",
    });
  });

  it("masks emails wherever they appear, including inside arrays", () => {
    expect(redactValue({ users: [{ email: "a@b.com" }], note: "ping c@d.org" })).toEqual({
      users: [{ email: "a***@b.com" }],
      note: "ping c***@d.org",
    });
  });

  it("survives a cycle", () => {
    const node: Record<string, unknown> = { name: "root" };
    node["self"] = node;
    expect(redactValue(node)).toEqual({ name: "root", self: "[circular]" });
  });

  it("truncates beyond the depth cap instead of recursing forever", () => {
    let deep: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[truncated]");
  });

  it("renders errors and dates as plain data", () => {
    const out = redactValue({
      err: new Error("failed for a@b.com"),
      at: new Date("2026-09-02T00:00:00.000Z"),
    }) as Record<string, unknown>;

    expect(out["err"]).toEqual({ name: "Error", message: "failed for a***@b.com" });
    expect(out["at"]).toBe("2026-09-02T00:00:00.000Z");
  });

  it("passes primitives through untouched", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(true)).toBe(true);
    expect(redactValue(undefined)).toBeUndefined();
  });
});

describe("redactLogObject", () => {
  it("is the pino hook shape and redacts", () => {
    expect(redactLogObject({ secret: "x", msg: "hello a@b.com" })).toEqual({
      secret: REDACTED,
      msg: "hello a***@b.com",
    });
  });
});

describe("REDACT_PATHS", () => {
  it("covers the credential-bearing headers of CONTRACTS §3 and §5", () => {
    expect(REDACT_PATHS).toContain("req.headers.authorization");
    expect(REDACT_PATHS).toContain('req.headers["x-api-key"]');
    expect(REDACT_PATHS).toContain('req.headers["x-license-key"]');
    expect(REDACT_PATHS).toContain('req.headers["x-montaj-signature"]');
  });
});
