import { describe, expect, it } from "vitest";

import { buildDeepLink, parseDeepLink } from "./parse.js";

describe("parseDeepLink", () => {
  it("parses an auth callback", () => {
    expect(parseDeepLink("aksharo://auth/callback?code=abc.123-XYZ_9")).toEqual({
      kind: "auth-callback",
      code: "abc.123-XYZ_9",
      state: undefined,
    });
  });

  it("parses an auth callback with state", () => {
    expect(parseDeepLink("aksharo://auth/callback?code=abc&state=csrf1")).toEqual({
      kind: "auth-callback",
      code: "abc",
      state: "csrf1",
    });
  });

  it("rejects an auth callback missing the code", () => {
    expect(parseDeepLink("aksharo://auth/callback")).toBeNull();
  });

  it("parses a project open with a valid ULID", () => {
    const ulid = "01J9ZQK6X8P0R2S4T6V8W0Y2Z4";
    expect(parseDeepLink(`aksharo://project/${ulid}`)).toEqual({
      kind: "open-project",
      projectId: ulid,
    });
  });

  it("rejects a project id that is not a ULID", () => {
    expect(parseDeepLink("aksharo://project/../../etc/passwd")).toBeNull();
    expect(parseDeepLink("aksharo://project/not-a-ulid")).toBeNull();
  });

  it("rejects a project route with extra path segments (path traversal shape)", () => {
    expect(parseDeepLink("aksharo://project/01J9ZQK6X8P0R2S4T6V8W0Y2Z4/extra")).toBeNull();
  });

  it("parses a bridge pair code", () => {
    expect(parseDeepLink("aksharo://pair?code=ab3dEFGH")).toEqual({
      kind: "bridge-pair",
      code: "AB3DEFGH",
    });
  });

  it("rejects a pair code with disallowed characters", () => {
    expect(parseDeepLink("aksharo://pair?code=<script>")).toBeNull();
  });

  it("rejects an unknown route", () => {
    expect(parseDeepLink("aksharo://settings/danger")).toBeNull();
  });

  it("rejects a foreign scheme even with a matching path", () => {
    expect(parseDeepLink("https://evil.example/pair?code=AAAAAAAA")).toBeNull();
  });

  it("rejects a malformed URL", () => {
    expect(parseDeepLink("aksharo://")).toBeNull();
    expect(parseDeepLink("not a url at all")).toBeNull();
  });

  it("round-trips through buildDeepLink", () => {
    const links = [
      { kind: "auth-callback", code: "tok123", state: "s1" } as const,
      { kind: "open-project", projectId: "01J9ZQK6X8P0R2S4T6V8W0Y2Z4" } as const,
      { kind: "bridge-pair", code: "AB3DEFGH" } as const,
    ];
    for (const link of links) {
      expect(parseDeepLink(buildDeepLink(link))).toEqual(link);
    }
  });
});
