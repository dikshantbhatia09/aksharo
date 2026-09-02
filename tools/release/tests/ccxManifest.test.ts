import { describe, expect, it } from "vitest";

import { validateUxpManifest } from "../src/lib/ccxManifest.js";

describe("validateUxpManifest", () => {
  it("accepts a manifest matching CONTRACTS §0 id and minVersion", () => {
    const result = validateUxpManifest({
      id: "ai.aksharo.panel",
      name: "Aksharo Captions",
      version: "1.2.3",
      host: [{ app: "PPRO", minVersion: "25.6" }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a wrong plugin id", () => {
    const result = validateUxpManifest({
      id: "com.example.wrong",
      name: "x",
      version: "1.0.0",
      host: [{ app: "PPRO", minVersion: "25.6" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ai.aksharo.panel"))).toBe(true);
  });

  it("rejects a minVersion below 25.6", () => {
    const result = validateUxpManifest({
      id: "ai.aksharo.panel",
      name: "x",
      version: "1.0.0",
      host: [{ app: "PPRO", minVersion: "23.0" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("minVersion"))).toBe(true);
  });

  it("rejects a manifest with no PPRO host entry", () => {
    const result = validateUxpManifest({
      id: "ai.aksharo.panel",
      name: "x",
      version: "1.0.0",
      host: [{ app: "AEFT", minVersion: "25.6" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("PPRO"))).toBe(true);
  });

  it("rejects a non-object manifest", () => {
    const result = validateUxpManifest(null);
    expect(result.valid).toBe(false);
  });

  it("rejects a missing version", () => {
    const result = validateUxpManifest({ id: "ai.aksharo.panel", name: "x", host: [{ app: "PPRO", minVersion: "25.6" }] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });
});
