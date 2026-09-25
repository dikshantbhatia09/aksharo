import { ImageResponse } from "next/og";

import { BRAND } from "@montaj/config";

/**
 * Shared 1200×630 OG image template, in the Shirorekha palette.
 *
 * Every colour here is a literal because `next/og` renders through Satori,
 * which has no CSS variables and no Tailwind — so these cannot read
 * `packages/ui/src/styles/tokens.css` and must be kept in step with it by
 * hand. They are, in order: `--color-bg-0`, `--color-fg-1`,
 * `--color-accent` (the shirorekha bar, the card's one accent), `--color-fg-0`
 * and `--color-fg-2`.
 *
 * The card is the product's signature at social-card scale: a flat warm
 * charcoal ground, and the title hanging from a short rani bar the way the
 * page titles do. No bloom or gradient — the system has none.
 */
export const OG_SIZE = { width: 1200, height: 630 };

const OG = {
  bg: "#141217",
  brand: "#d6cfc8",
  accent: "#f0508a",
  title: "#f1ece6",
  subtitle: "#a39a93",
} as const;

export function renderOgImage(title: string, subtitle: string): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 80,
        backgroundColor: OG.bg,
        color: OG.title,
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", fontSize: 32, fontWeight: 600, color: OG.brand }}>
        {BRAND.name}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            display: "flex",
            width: 72,
            height: 7,
            borderRadius: 4,
            backgroundColor: OG.accent,
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 600,
            lineHeight: 1.08,
            letterSpacing: "-0.01em",
            maxWidth: 1000,
          }}
        >
          {title}
        </div>
        <div style={{ display: "flex", fontSize: 30, color: OG.subtitle, maxWidth: 900 }}>
          {subtitle}
        </div>
      </div>
    </div>,
    { ...OG_SIZE },
  );
}
