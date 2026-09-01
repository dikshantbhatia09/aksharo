import { describe, expect, it } from "vitest";

import { cn } from "./utils.js";

describe("cn", () => {
  it("joins class names", () => {
    expect(cn("px-2", "py-1")).toBe("px-2 py-1");
  });

  it("drops falsy values", () => {
    expect(cn("px-2", false, undefined, null, "py-1")).toBe("px-2 py-1");
  });

  it("lets the last conflicting Tailwind utility win", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm text-red-500", "text-lg")).toBe("text-red-500 text-lg");
  });

  it("supports conditional objects and arrays", () => {
    expect(cn(["rounded", { "bg-black": true, "bg-white": false }])).toBe("rounded bg-black");
  });
});
