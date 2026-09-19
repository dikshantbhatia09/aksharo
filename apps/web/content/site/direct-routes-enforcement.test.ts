import { describe, expect, it, vi } from "vitest";

import AffiliatePage, { generateMetadata as affiliateMetadata } from "@/app/(app)/affiliate/page";
import LicenseKeysPage, {
  generateMetadata as licenseKeysMetadata,
} from "@/app/(app)/plugins/keys/page";
import PluginsAppPage, {
  generateMetadata as pluginsAppMetadata,
} from "@/app/(app)/plugins-app/page";
import SharePage, { generateMetadata as shareMetadata } from "@/app/(share)/share/[token]/page";
import ShareRootPage from "@/app/(share)/share/page";
import DocsPluginGuidePage, {
  generateMetadata as docsPluginGuideMetadata,
} from "@/app/(site)/(marketing)/docs/plugins/[slug]/page";
import DocsPluginsPage, {
  generateMetadata as docsPluginsMetadata,
} from "@/app/(site)/(marketing)/docs/plugins/page";
import DownloadPage, {
  generateMetadata as downloadMetadata,
} from "@/app/(site)/(marketing)/download/page";
import PluginsPage, {
  generateMetadata as pluginsMetadata,
} from "@/app/(site)/(marketing)/plugins/page";
import { GET as affiliateRedirectHandler } from "@/app/(site)/r/[code]/route";

// Mock fetchPluginManifest so network is not required
vi.mock("@/lib/plugin-manifest", () => ({
  fetchPluginManifest: vi.fn().mockResolvedValue({
    desktop: {
      available: true,
      version: "1.0.0",
      channel: "stable",
      notes: "Release build",
      downloadUrl: { win: "https://example.com/win.exe" },
    },
    channels: {},
  }),
}));

describe("direct-route & OpenGraph metadata enforcement (RLS-006)", () => {
  describe("desktop surface (/download)", () => {
    it("fails closed: throws notFound and emits no metadata when disabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = "{}";
        expect(() => downloadMetadata()).toThrow();
        await expect(DownloadPage()).rejects.toThrow();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });

    it("serves page and emits OpenGraph metadata when desktop surface is enabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "desktop.download": true });
        const meta = downloadMetadata();
        expect(meta.title).toBe("Download");
        expect(meta.openGraph).toBeDefined();
        expect(meta.openGraph?.url).toBe("/download");

        const page = await DownloadPage();
        expect(page).toBeDefined();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });
  });

  describe("plugins surface (/plugins, /plugins-app, /plugins/keys, /docs/plugins)", () => {
    it("fails closed: all plugin pages, guides, and metadata throw notFound when disabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = "{}";
        // /plugins marketing
        expect(() => pluginsMetadata()).toThrow();
        await expect(PluginsPage()).rejects.toThrow();

        // /plugins-app
        expect(() => pluginsAppMetadata()).toThrow();
        expect(() => PluginsAppPage()).toThrow();

        // /plugins/keys
        expect(() => licenseKeysMetadata()).toThrow();
        expect(() => LicenseKeysPage()).toThrow();

        // /docs/plugins index
        expect(() => docsPluginsMetadata()).toThrow();
        expect(() => DocsPluginsPage()).toThrow();

        // /docs/plugins/[slug]
        await expect(
          docsPluginGuideMetadata({ params: Promise.resolve({ slug: "premiere" }) }),
        ).rejects.toThrow();
        await expect(
          DocsPluginGuidePage({ params: Promise.resolve({ slug: "premiere" }) }),
        ).rejects.toThrow();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });

    it("serves pages and emits metadata when plugins surface is enabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "plugins.enabled": true });
        const meta = pluginsMetadata();
        expect(meta.title).toBe("Plugins");
        expect(meta.openGraph).toBeDefined();

        const page = await PluginsPage();
        expect(page).toBeDefined();

        expect(pluginsAppMetadata().title).toBe("Plugins");
        expect(PluginsAppPage()).toBeDefined();

        expect(licenseKeysMetadata().title).toBe("Licence keys");
        expect(LicenseKeysPage()).toBeDefined();

        expect(docsPluginsMetadata().title).toBe("Plugin guides");
        expect(DocsPluginsPage()).toBeDefined();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });
  });

  describe("affiliates surface (/affiliate and /r/[code])", () => {
    it("fails closed: /affiliate throws notFound and /r/[code] returns 404 when disabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = "{}";
        expect(() => affiliateMetadata()).toThrow();
        expect(() => AffiliatePage()).toThrow();

        const req = new Request("https://aksharo.ai/r/TESTCODE");
        const res = await affiliateRedirectHandler(req, {
          params: Promise.resolve({ code: "TESTCODE" }),
        });
        expect(res.status).toBe(404);
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });

    it("serves /affiliate and admits /r/[code] when affiliates surface is enabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "affiliates.enabled": true });
        expect(affiliateMetadata().title).toBe("Refer & earn");
        expect(AffiliatePage()).toBeDefined();

        const req = new Request("https://aksharo.ai/r/VALIDCODE");
        const res = await affiliateRedirectHandler(req, {
          params: Promise.resolve({ code: "VALIDCODE" }),
        });
        // Redirects to signup with referral query param
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("/signup?ref=VALIDCODE");
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });
  });

  describe("publicShares surface (/share/[token] and /share)", () => {
    it("fails closed: throws notFound and emits no metadata when disabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = "{}";
        expect(() => shareMetadata()).toThrow();
        await expect(SharePage({ params: Promise.resolve({ token: "tok123" }) })).rejects.toThrow();
        expect(() => ShareRootPage()).toThrow();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });

    it("serves shared review and emits metadata when publicShares surface is enabled", async () => {
      const prev = process.env["FEATURE_FLAGS_JSON"];
      try {
        process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({ "shares.public": true });
        const meta = shareMetadata();
        expect(meta.title).toBe("Shared review");
        expect(meta.openGraph?.title).toBe("Shared review");

        const page = await SharePage({ params: Promise.resolve({ token: "tok123" }) });
        expect(page).toBeDefined();
      } finally {
        process.env["FEATURE_FLAGS_JSON"] = prev;
      }
    });
  });
});
