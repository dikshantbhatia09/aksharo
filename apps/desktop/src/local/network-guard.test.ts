import { describe, expect, it } from "vitest";

import { createLocalModeState, isUploadBlocked } from "./network-guard.js";

const API_ORIGINS = ["https://api.aksharo.ai", "https://api.aksharo.app"];

describe("isUploadBlocked", () => {
  it("allows everything when no local project is open", () => {
    expect(
      isUploadBlocked(
        { method: "POST", url: "https://api.aksharo.ai/projects/p1/media" },
        { localModeActive: false, apiOrigins: API_ORIGINS },
      ),
    ).toBe(false);
  });

  it("blocks a POST to the API while a local project is open", () => {
    expect(
      isUploadBlocked(
        { method: "POST", url: "https://api.aksharo.ai/projects/p1/media" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(true);
  });

  it("blocks a PUT/PATCH to the API's alt domain too", () => {
    expect(
      isUploadBlocked(
        { method: "PUT", url: "https://api.aksharo.app/projects/p1/edg/import" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(true);
    expect(
      isUploadBlocked(
        { method: "PATCH", url: "https://api.aksharo.app/projects/p1" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(true);
  });

  it("never blocks a GET, even to the API, while local mode is active", () => {
    expect(
      isUploadBlocked(
        { method: "GET", url: "https://api.aksharo.ai/projects/p1" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(false);
  });

  it("never blocks a POST to an origin other than the API (the local engine, an OAuth provider, a CDN)", () => {
    expect(
      isUploadBlocked(
        { method: "POST", url: "http://127.0.0.1:4823/transcribe" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(false);
    expect(
      isUploadBlocked(
        { method: "POST", url: "https://accounts.google.com/o/oauth2/token" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(false);
  });

  it("fails safe on an unparseable URL: never blocks (never crashes either)", () => {
    expect(
      isUploadBlocked(
        { method: "POST", url: "not a url" },
        { localModeActive: true, apiOrigins: API_ORIGINS },
      ),
    ).toBe(false);
  });
});

describe("createLocalModeState", () => {
  it("starts inactive by default and toggles on demand", () => {
    const state = createLocalModeState();
    expect(state.isActive()).toBe(false);
    state.setActive(true);
    expect(state.isActive()).toBe(true);
    state.setActive(false);
    expect(state.isActive()).toBe(false);
  });

  it("accepts an explicit initial value", () => {
    expect(createLocalModeState(true).isActive()).toBe(true);
  });
});
