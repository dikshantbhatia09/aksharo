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
    // They are how a browser with a cookie and no access token gets one; a
    // redirect here would make signing in impossible.
    for (const path of config.matcher) {
      expect(path.startsWith("/api")).toBe(false);
    }
    expect(middleware(request("/api/session/refresh")).headers.get("location")).toBeNull();
  });
});
