import { describe, expect, it } from "vitest";

import sitemap from "@/app/(site)/sitemap";

describe("sitemap launch surface filtering (RLS-006 crawler gate)", () => {
  it("omits /download, /plugins, and /docs/plugins/* when surfaces are disabled", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = "{}";
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls.some((u) => u.endsWith("/download"))).toBe(false);
      expect(urls.some((u) => u.endsWith("/plugins"))).toBe(false);
      expect(urls.some((u) => u.includes("/docs/plugins"))).toBe(false);

      // Shipped surfaces remain present
      expect(urls.some((u) => u.endsWith("/features"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/pricing"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/changelog"))).toBe(true);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });

  it("includes /download when desktop surface is enabled", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "desktop.download": true });
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls.some((u) => u.endsWith("/download"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/plugins"))).toBe(false);
      expect(urls.some((u) => u.includes("/docs/plugins"))).toBe(false);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });

  it("includes /plugins and plugin guides when plugins surface is enabled", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "plugins.enabled": true });
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls.some((u) => u.endsWith("/plugins"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/docs/plugins"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/download"))).toBe(false);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });
});
