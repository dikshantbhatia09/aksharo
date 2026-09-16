import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCENT,
  ACCENT_RAMP,
  MOTION,
  NEUTRAL,
  RADIUS,
  SIGNAL,
  SURFACE,
  TEXT,
  TOKENS,
} from "./tokens";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "styles", "tokens.css"),
  "utf8",
);

/** `--color-bg-1: #232532;` → `#232532`. */
function cssVar(name: string): string | undefined {
  // eslint-disable-next-line security/detect-non-literal-regexp -- RegExp built from a fixed/internal string (test fixture or bounded value, not attacker input) -- reviewed for M06's eslint-plugin-security promotion
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
    ["color-surface", SURFACE.surface],
    ["color-sunken", SURFACE.sunken],
    ["color-ink", SURFACE.ink],
    ["color-lime-500", ACCENT.lime500],
    ["color-lime-600", ACCENT.lime600],
    ["color-accent", ACCENT.lime500],
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

  it.each(Object.entries(ACCENT_RAMP))("stylesheet carries accent step %s", (step, value) => {
    expect(cssVar(`color-accent-${step}`)).toBe(value);
  });

  it.each(Object.entries(NEUTRAL))("stylesheet carries neutral step %s", (step, value) => {
    expect(cssVar(`color-neutral-${step}`)).toBe(value);
  });

  /*
   * Nocturne's one hard colour rule: no pure black and no pure white anywhere
   * in the chrome. The caption tokens are the documented exception — they burn
   * into exported video over footage nobody controls — so the check reads the
   * stylesheet with that block removed rather than allow-listing hexes.
   */
  it("uses no pure black or pure white outside the caption defaults", () => {
    const chrome = css.replace(/--color-caption-[a-z]+:[^;]+;/g, "");
    expect(chrome).not.toMatch(/#fff\b|#ffffff/i);
    expect(chrome).not.toMatch(/#000\b|#000000/i);
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
    expect(TOKENS.accent.lime500).toBe(ACCENT.lime500);
    expect(Object.keys(TOKENS.signal)).toHaveLength(5);
  });
});
