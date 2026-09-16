import { ImageResponse } from "next/og";

import { BRAND } from "@montaj/config";

/**
 * Shared 1200×630 OG image template, in the Nocturne palette.
 *
 * Every colour here is a literal because `next/og` renders through Satori,
 * which has no CSS variables and no Tailwind — so these cannot read
 * `packages/ui/src/styles/tokens.css` and must be kept in step with it by
 * hand. They are, in order: `--color-bg-0`, `--color-accent-900` as the
 * bloom, `--color-fg-0`, `--color-accent` and `--color-fg-1`.
 */
export const OG_SIZE = { width: 1200, height: 630 };

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
        backgroundColor: "#161826",
        backgroundImage:
          "radial-gradient(circle at 15% 15%, rgba(66,58,106,0.55), transparent 55%)",
        color: "#e9e9ed",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", fontSize: 36, fontWeight: 500, color: "#9184d9" }}>
        {BRAND.name}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 500, maxWidth: 1000 }}>
          {title}
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#cfd3e5", maxWidth: 900 }}>
          {subtitle}
        </div>
      </div>
    </div>,
    { ...OG_SIZE },
  );
}
