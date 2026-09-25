import { describe, expect, it } from "vitest";

import { BRAND, CODENAME } from "@montaj/config";

import { parseFlags } from "./flags";
import { ALL_NAV, isActivePath, PRIMARY_NAV, SECONDARY_NAV, SETTINGS_NAV } from "./nav";

describe("PRIMARY_NAV", () => {
  it("is the premium canvas's rail, in its order", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual([
      "Clips pipeline",
      "Studio",
      "Projects",
      "Editor",
      "Styles",
      "Plan and credits",
      "Settings",
      "First run",
    ]);
  });

  it("gives the 68 px rail a one-word caption for every entry", () => {
    for (const item of PRIMARY_NAV) {
      expect(item.short, item.label).toBeTruthy();
      // The rail draws it at 9 px under a 19 px icon; two words do not fit.
      expect(item.short.split(" "), item.label).toHaveLength(1);
    }
  });

  /*
   * The canvas's rail has room for eight, and the routes it left out are
   * shipped pages, not future ones. They have to stay reachable, so the
   * expanded sidebar lists them under "More" and the command palette offers
   * every one of them. Dropping a route on the floor during a redesign is the
   * failure this test exists to catch.
   */
  it("keeps every shipped destination reachable, primary or secondary", () => {
    expect(SECONDARY_NAV.map((item) => item.label)).toEqual([
      "Templates",
      "Academy",
      "Plugins",
      "Team",
      "Refer & earn",
      "Help",
    ]);
    expect(ALL_NAV).toHaveLength(PRIMARY_NAV.length + SECONDARY_NAV.length);
  });

  it("has no duplicate keys across the two groups", () => {
    const keys = ALL_NAV.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names the owning work package for everything not built yet", () => {
    for (const item of ALL_NAV) {
      if (!item.ready) expect(item.owner, item.label).toBeTruthy();
    }
  });

  it("never shows the codename (CONTRACTS §0)", () => {
    const copy = [
      ...ALL_NAV.map((item) => `${item.label} ${item.short} ${item.href}`),
      ...SETTINGS_NAV.map((item) => `${item.label} ${item.description} ${item.href}`),
    ].join(" ");
    expect(copy.toLowerCase()).not.toContain(CODENAME);
    expect(SETTINGS_NAV.map((item) => item.label)).toContain(`What ${BRAND.name} learned`);
  });
});

describe("SETTINGS_NAV", () => {
  it("covers the sections of 08 §Settings that A13 owns, plus B04's Subscription section, B08's Licence keys, and B14's Developers", () => {
    expect(SETTINGS_NAV.map((item) => item.key)).toEqual([
      "profile",
      "languages",
      "memory",
      "devices",
      "privacy",
      "notifications",
      "support",
      "subscription",
      "plugin-keys",
      "developers",
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
