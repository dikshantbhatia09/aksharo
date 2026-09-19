import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { config, middleware } from "./middleware";

function request(path: string, cookie?: string): NextRequest {
  const url = `https://aksharo.ai${path}`;
  return new NextRequest(url, cookie === undefined ? {} : { headers: { cookie } });
}

const SIGNED_IN = "aksharo_rt=opaque-refresh-token";

describe("middleware", () => {
  it("sends a signed-out visitor to sign in, remembering where they were going", () => {
    const response = middleware(request("/settings/privacy?tab=consents"));
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/settings/privacy?tab=consents");
  });

  it("protects the device-approval screen, because approving needs a session (T3)", () => {
    const response = middleware(request("/device?user_code=4F7K92QA"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
  });

  it("lets a signed-in visitor through", () => {
    const response = middleware(request("/settings/privacy", SIGNED_IN));
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps a signed-in visitor off the sign-in pages", () => {
    for (const path of ["/login", "/signup", "/magic"]) {
      const response = middleware(request(path, SIGNED_IN));
      expect(new URL(response.headers.get("location") ?? "").pathname, path).toBe("/");
    }
  });

  it("leaves the marketing home alone in both directions", () => {
    expect(middleware(request("/")).headers.get("location")).toBeNull();
    expect(middleware(request("/", SIGNED_IN)).headers.get("location")).toBeNull();
  });

  it("never intercepts the session route handlers", () => {
    for (const path of config.matcher) {
      expect(path.startsWith("/api")).toBe(false);
    }
    expect(middleware(request("/api/session/refresh")).headers.get("location")).toBeNull();
  });
});

describe("middleware launch-surface edge enforcement (RLS-006)", () => {
  it("fails closed (404) on unavailable surfaces when flags are empty", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = "{}";

      expect(middleware(request("/download")).status).toBe(404);
      expect(middleware(request("/download/mac")).status).toBe(404);

      expect(middleware(request("/plugins")).status).toBe(404);
      expect(middleware(request("/plugins", SIGNED_IN)).status).toBe(404);
      expect(middleware(request("/plugins/keys", SIGNED_IN)).status).toBe(404);
      expect(middleware(request("/plugins-app", SIGNED_IN)).status).toBe(404);
      expect(middleware(request("/docs/plugins")).status).toBe(404);

      expect(middleware(request("/affiliate")).status).toBe(404);
      expect(middleware(request("/r/REFCODE")).status).toBe(404);

      expect(middleware(request("/share")).status).toBe(404);
      expect(middleware(request("/share/some-token-abc")).status).toBe(404);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });

  it("admits routes when matching launch surfaces are enabled", () => {
    const prev = process.env["FEATURE_FLAGS_JSON"];
    try {
      process.env["FEATURE_FLAGS_JSON"] = JSON.stringify({
        "desktop.download": true,
        "plugins.enabled": true,
        "affiliates.enabled": true,
        "shares.public": true,
      });

      // Desktop
      const downloadRes = middleware(request("/download"));
      expect(downloadRes.status).toBe(200);

      // Plugins signed-out marketing
      const pluginsOut = middleware(request("/plugins"));
      expect(pluginsOut.headers.get("x-middleware-rewrite")).toBeNull();

      // Plugins signed-in rewrite
      const pluginsIn = middleware(request("/plugins", SIGNED_IN));
      const rewrite = new URL(pluginsIn.headers.get("x-middleware-rewrite") ?? "");
      expect(rewrite.pathname).toBe("/plugins-app");

      // Plugins keys
      expect(middleware(request("/plugins/keys", SIGNED_IN)).status).toBe(200);

      // Affiliates
      expect(middleware(request("/affiliate", SIGNED_IN)).status).toBe(200);
      expect(middleware(request("/r/REFCODE")).status).toBe(200);

      // Public shares
      expect(middleware(request("/share/some-token-abc")).status).toBe(200);
    } finally {
      process.env["FEATURE_FLAGS_JSON"] = prev;
    }
  });
});
