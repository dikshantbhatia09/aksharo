import { describe, expect, it } from "vitest";

import { redactConfig, redactText, tailAndRedact } from "./redact.js";

describe("redactText", () => {
  it("redacts email addresses", () => {
    expect(redactText("contact dikshant@example.com for help")).toBe(
      "contact [redacted:email] for help",
    );
  });

  it("redacts bearer tokens", () => {
    expect(redactText("Authorization: Bearer abcdef1234567890abcdef")).toContain(
      "Bearer [redacted:token]",
    );
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMiLCJ3cyI6IjQ1NiJ9.signature-part-abcdefghij";
    expect(redactText(`token=${jwt}`)).not.toContain("eyJ");
  });

  it("redacts a Windows user path down to the account name", () => {
    expect(redactText("at C:\\Users\\dikshant\\AppData\\Local\\app.log")).toBe(
      "at C:\\Users\\[redacted:user]",
    );
  });

  it("redacts a macOS home path", () => {
    expect(redactText("/Users/dikshant/Library/Logs/app.log")).toBe(
      "/Users/[redacted:user]/Library/Logs/app.log",
    );
  });

  it("redacts a Linux home path", () => {
    expect(redactText("/home/dikshant/.config/app/log")).toBe(
      "/home/[redacted:user]/.config/app/log",
    );
  });

  it("redacts IPv4 addresses", () => {
    expect(redactText("connected to 192.168.1.42")).toBe("connected to [redacted:ip]");
  });

  it("redacts long opaque tokens", () => {
    expect(redactText("apikey=sk_live_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(
      "apikey=[redacted:token]",
    );
  });

  it("leaves ordinary text untouched", () => {
    expect(redactText("render finished in 4.2s")).toBe("render finished in 4.2s");
  });
});

describe("tailAndRedact", () => {
  it("keeps only the last N lines, then redacts", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} user@example.com`);
    const result = tailAndRedact(lines, 50);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe("line 50 [redacted:email]");
    expect(result.every((l) => !l.includes("@example.com"))).toBe(true);
  });

  it("returns all lines when limit exceeds length", () => {
    const lines = ["a", "b"];
    expect(tailAndRedact(lines, 50)).toEqual(["a", "b"]);
  });
});

describe("redactConfig", () => {
  it("drops values of secret-shaped keys", () => {
    const result = redactConfig({
      apiKey: "sk_live_123",
      jwtSecret: "x",
      other: "value",
    }) as Record<string, unknown>;
    expect(result["apiKey"]).toBe("[redacted]");
    expect(result["jwtSecret"]).toBe("[redacted]");
    expect(result["other"]).toBe("value");
  });

  it("recurses into nested objects and arrays", () => {
    const result = redactConfig({
      nested: { password: "hunter2", list: ["a@b.com", "fine"] },
    }) as Record<string, unknown>;
    const nested = result["nested"] as Record<string, unknown>;
    expect(nested["password"]).toBe("[redacted]");
    expect(nested["list"]).toEqual(["[redacted:email]", "fine"]);
  });
});
