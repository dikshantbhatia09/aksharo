import { ImageResponse } from "next/og";

import { BRAND } from "@montaj/config";

/** Shared 1200×630 OG image template — near-black + lime, on brand (08 §1). */
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
        backgroundColor: "#0B0B0E",
        backgroundImage:
          "radial-gradient(circle at 15% 15%, rgba(216,255,61,0.16), transparent 55%)",
        color: "#F5F5F7",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", fontSize: 36, fontWeight: 700, color: "#D8FF3D" }}>
        {BRAND.name}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700, maxWidth: 1000 }}>
          {title}
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#C9C9D1", maxWidth: 900 }}>
          {subtitle}
        </div>
      </div>
    </div>,
    { ...OG_SIZE },
  );
}
