import { describe, expect, it } from "vitest";

import { resolveCoarseLocation } from "./geo.js";

describe("resolveCoarseLocation", () => {
  it("returns nothing when no edge resolved anything", () => {
    expect(resolveCoarseLocation({})).toBeUndefined();
    expect(resolveCoarseLocation({ "user-agent": "curl" })).toBeUndefined();
  });

  it("reads the country a CDN put on the request", () => {
    expect(resolveCoarseLocation({ "cf-ipcountry": "in" })).toEqual({ country: "IN" });
    expect(resolveCoarseLocation({ "x-vercel-ip-country": "DE" })).toEqual({ country: "DE" });
  });

  it("treats Cloudflare's unknown and Tor markers as no answer", () => {
    expect(resolveCoarseLocation({ "cf-ipcountry": "XX" })).toBeUndefined();
    expect(resolveCoarseLocation({ "cf-ipcountry": "T1" })).toBeUndefined();
  });

  it("adds region and city, url-decoded, only alongside a country", () => {
    expect(
      resolveCoarseLocation({
        "cf-ipcountry": "IN",
        "x-vercel-ip-country-region": "MH",
        "cf-ipcity": "New%20Delhi",
      }),
    ).toEqual({ country: "IN", region: "MH", city: "New Delhi" });

    // A city with no country is not a location anyone can act on.
    expect(resolveCoarseLocation({ "cf-ipcity": "Nowhere" })).toBeUndefined();
  });

  it("takes the first header when several are present, and the first value of an array", () => {
    expect(resolveCoarseLocation({ "cf-ipcountry": "IN", "x-vercel-ip-country": "DE" })).toEqual({
      country: "IN",
    });
    expect(resolveCoarseLocation({ "cf-ipcountry": ["FR", "DE"] })).toEqual({ country: "FR" });
  });

  it("truncates values a hostile edge could pad", () => {
    const long = "x".repeat(500);
    const resolved = resolveCoarseLocation({ "cf-ipcountry": "IN", "cf-ipcity": long });
    expect(resolved?.city).toHaveLength(64);
    expect(resolved?.country).toBe("IN");
  });
});
