import { describe, expect, it } from "vitest";

import { BRAND, CODENAME } from "@montaj/config";

import { parseFlags } from "./flags";
import { isActivePath, PRIMARY_NAV, SETTINGS_NAV } from "./nav";

describe("PRIMARY_NAV", () => {
  it("is the information architecture of 08 §3, in order", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual([
      "Home",
      "Projects",
      "Templates",
      "Academy",
      "Plugins",
      "Team",
      "Subscription",
      "Refer & Earn",
      "Help",
    ]);
  });

  it("names the owning work package for everything not built yet", () => {
    for (const item of PRIMARY_NAV) {
      if (!item.ready) expect(item.owner, item.label).toBeTruthy();
    }
  });

  it("never shows the codename (CONTRACTS §0)", () => {
    const copy = [
      ...PRIMARY_NAV.map((item) => `${item.label} ${item.href}`),
      ...SETTINGS_NAV.map((item) => `${item.label} ${item.description} ${item.href}`),
    ].join(" ");
    expect(copy.toLowerCase()).not.toContain(CODENAME);
    expect(SETTINGS_NAV.map((item) => item.label)).toContain(`What ${BRAND.name} learned`);
  });
});

describe("SETTINGS_NAV", () => {
  it("covers the sections of 08 §Settings that A13 owns, plus B04's Subscription section and B08's Licence keys", () => {
    expect(SETTINGS_NAV.map((item) => item.key)).toEqual([
      "profile",
      "languages",
      "memory",
      "devices",
      "privacy",
      "notifications",
      "subscription",
      "plugin-keys",
    ]);
  });
});

describe("isActivePath", () => {
  it("matches a section and its children", () => {
    expect(isActivePath("/settings/privacy", "/settings/privacy")).toBe(true);
    expect(isActivePath("/settings/privacy/export", "/settings/privacy")).toBe(true);
    expect(isActivePath("/settings/profile", "/settings/privacy")).toBe(false);
  });

  it("does not let the root match everything", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/settings/profile", "/")).toBe(false);
  });

  it("does not match a prefix that is only a partial segment", () => {
    expect(isActivePath("/settings-old", "/settings")).toBe(false);
  });
});

describe("parseFlags", () => {
  it("reads FEATURE_FLAGS_JSON and keeps only booleans", () => {
    expect(parseFlags('{"growth.streakWidget":true,"x":"yes","y":false}')).toEqual({
      "growth.streakWidget": true,
      y: false,
    });
  });

  it("never throws on a malformed value", () => {
    expect(parseFlags("{not json")).toEqual({});
    expect(parseFlags("[]")).toEqual({});
    expect(parseFlags("null")).toEqual({});
    expect(parseFlags(null)).toEqual({});
  });
});
