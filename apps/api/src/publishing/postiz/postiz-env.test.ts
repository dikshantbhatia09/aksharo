import { describe, expect, it } from "vitest";

import {
  DEFAULT_POSTIZ_APP_URL,
  postizAppUrl,
  postizSetting,
  postizWorkspaceIds,
  publishWorkerEnabled,
} from "./postiz-env.js";

describe("postizSetting", () => {
  it("is unset without a key, whatever the URL says", () => {
    expect(postizSetting({})).toEqual({ kind: "unset" });
    expect(
      postizSetting({ POSTIZ_API_KEY: "   ", POSTIZ_API_URL: "https://p.example/api" }),
    ).toEqual({ kind: "unset" });
  });

  it("defaults to the bundled image on this machine, and links people to localhost", () => {
    expect(postizSetting({ POSTIZ_API_KEY: "k" })).toEqual({
      kind: "ok",
      apiUrl: "http://127.0.0.1:4007/api",
      apiKey: "k",
      // Postiz's sign-in cookie is for its FRONTEND_URL host, `localhost`.
      appUrl: DEFAULT_POSTIZ_APP_URL,
    });
  });

  it("takes an HTTPS Postiz anywhere, and derives where to open it", () => {
    expect(
      postizSetting({ POSTIZ_API_KEY: "k", POSTIZ_API_URL: "https://postiz.example.com/api/" }),
    ).toEqual({
      kind: "ok",
      apiUrl: "https://postiz.example.com/api",
      apiKey: "k",
      appUrl: "https://postiz.example.com",
    });
    expect(
      postizSetting({
        POSTIZ_API_KEY: "k",
        POSTIZ_API_URL: "https://postiz.example.com/api",
        POSTIZ_APP_URL: "https://app.example.com/",
      }),
    ).toMatchObject({ appUrl: "https://app.example.com" });
  });

  it("never sends the key in clear across a network, or to a URL carrying credentials", () => {
    expect(
      postizSetting({ POSTIZ_API_KEY: "k", POSTIZ_API_URL: "http://10.0.0.5:4007/api" }),
    ).toEqual({ kind: "invalid", problem: "insecure" });
    expect(
      postizSetting({ POSTIZ_API_KEY: "k", POSTIZ_API_URL: "https://u:p@postiz.example.com/api" }),
    ).toEqual({ kind: "invalid", problem: "has_credentials" });
    expect(postizSetting({ POSTIZ_API_KEY: "k", POSTIZ_API_URL: "not a url" })).toEqual({
      kind: "invalid",
      problem: "not_a_url",
    });
    expect(
      postizSetting({ POSTIZ_API_KEY: "k", POSTIZ_API_URL: "http://localhost:5000/api" }),
    ).toMatchObject({ kind: "ok", apiUrl: "http://localhost:5000/api" });
  });
});

describe("postizAppUrl", () => {
  it("answers even before a key is set, so the settings page can say where to get one", () => {
    expect(postizAppUrl({})).toBe("http://localhost:4007");
    expect(postizAppUrl({ POSTIZ_API_URL: "https://postiz.example.com/api" })).toBe(
      "https://postiz.example.com",
    );
    expect(postizAppUrl({ POSTIZ_APP_URL: "https://open.example.com" })).toBe(
      "https://open.example.com",
    );
  });
});

describe("postizWorkspaceIds / publishWorkerEnabled", () => {
  it("reads a comma list of workspaces, trimmed and deduplicated", () => {
    expect(postizWorkspaceIds({})).toEqual([]);
    expect(postizWorkspaceIds({ POSTIZ_WORKSPACE_IDS: " A , B,A,, " })).toEqual(["A", "B"]);
  });

  it("runs the worker unless told not to", () => {
    expect(publishWorkerEnabled({})).toBe(true);
    for (const off of ["0", "false", "OFF", "no"]) {
      expect(publishWorkerEnabled({ PUBLISH_WORKER_ENABLED: off }), off).toBe(false);
    }
  });
});
