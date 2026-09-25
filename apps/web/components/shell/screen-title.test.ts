import { describe, expect, it } from "vitest";

import { screenTitleFor } from "./screen-title";

import { PRIMARY_NAV } from "@/lib/nav";

describe("screenTitleFor", () => {
  it("names each primary destination with the nav's own label", () => {
    // The rail says "Styles"; the header must not answer with "Caption styles".
    for (const item of PRIMARY_NAV) {
      if (item.key === "editor") continue; // resolves to /projects until a project exists
      expect(screenTitleFor(item.href).crumb).toBe(item.label);
    }
  });

  it("adds a second segment only for sub-pages the section name leaves ambiguous", () => {
    expect(screenTitleFor("/settings/profile")).toEqual({ crumb: "Settings", title: "Profile" });
    expect(screenTitleFor("/projects")).toEqual({ crumb: "Projects" });
  });

  it("prefers the longest matching prefix and falls back to the studio", () => {
    expect(screenTitleFor("/billing/usage")).toEqual({ crumb: "Plan and credits", title: "Usage" });
    expect(screenTitleFor("/p/01ABC")).toEqual({ crumb: "Editor" });
    expect(screenTitleFor("/nowhere")).toEqual({ crumb: "Studio" });
    expect(screenTitleFor(null)).toEqual({ crumb: "Studio" });
  });
});
