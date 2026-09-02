import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACCENT, MOTION, RADIUS, SIGNAL, SURFACE, TEXT, TOKENS } from "./tokens";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles", "tokens.css"),
  "utf8",
);

/** `--color-bg-1: #131318;` → `#131318`. */
function cssVar(name: string): string | undefined {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return match?.[1]?.trim();
}

describe("design tokens", () => {
  it.each([
    ["color-bg-0", SURFACE.bg0],
    ["color-bg-1", SURFACE.bg1],
    ["color-bg-2", SURFACE.bg2],
    ["color-border", SURFACE.border],
    ["color-fg-0", TEXT.fg0],
    ["color-fg-1", TEXT.fg1],
    ["color-fg-2", TEXT.fg2],
    ["color-fg-disabled", TEXT.disabled],
    ["color-lime-500", ACCENT.lime500],
    ["color-lime-600", ACCENT.lime600],
    ["color-on-accent", ACCENT.onAccent],
    ["color-proposed", SIGNAL.proposed],
    ["color-accepted", SIGNAL.accepted],
    ["color-rejected", SIGNAL.rejected],
    ["color-info", SIGNAL.info],
    ["color-warning", SIGNAL.warning],
  ])("stylesheet and module agree on %s", (name, value) => {
    expect(cssVar(name)).toBe(value.toLowerCase());
  });

  it.each([
    ["radius-sm", RADIUS.sm],
    ["radius-md", RADIUS.md],
    ["radius-lg", RADIUS.lg],
  ])("stylesheet and module agree on %s", (name, value) => {
    expect(cssVar(name)).toBe(value);
  });

  it("keeps the studio dark-only: one palette, no light override", () => {
    expect(css).not.toMatch(/prefers-color-scheme:\s*light/);
    expect(css).toContain("color-scheme: dark");
  });

  it("honours prefers-reduced-motion for UI chrome", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps UI motion inside the 120–200 ms band of 08 §1", () => {
    for (const duration of [MOTION.fast, MOTION.base, MOTION.slow]) {
      const ms = Number.parseInt(duration, 10);
      expect(ms).toBeGreaterThanOrEqual(120);
      expect(ms).toBeLessThanOrEqual(200);
    }
  });

  it("exposes one aggregate for consumers that need the whole palette", () => {
    expect(TOKENS.accent.lime500).toBe("#D8FF3D");
    expect(Object.keys(TOKENS.signal)).toHaveLength(5);
  });
});
