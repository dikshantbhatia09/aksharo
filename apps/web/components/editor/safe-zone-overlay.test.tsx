import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SafeZoneOverlay } from "./safe-zone-overlay";

describe("<SafeZoneOverlay /> (Pillar 3 §08 Step 2)", () => {
  const defaultFit = {
    left: 20,
    top: 10,
    width: 360,
    height: 640,
    scale: 0.333,
  };
  const canvas = { width: 1080, height: 1920 };

  it("renders the universal safe zone guides by default", () => {
    render(
      <SafeZoneOverlay
        fit={defaultFit}
        canvas={canvas}
        platform="universal"
        showGuides={true}
      />,
    );

    expect(screen.getByTestId("safe-zone-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("safe-zone-guides")).toBeInTheDocument();
  });

  it("renders TikTok wireframe chrome when platform is tiktok", () => {
    render(
      <SafeZoneOverlay
        fit={defaultFit}
        canvas={canvas}
        platform="tiktok"
        showChrome={true}
      />,
    );

    expect(screen.getByTestId("safe-zone-overlay")).toHaveAttribute(
      "data-platform",
      "tiktok",
    );
    expect(screen.getByTestId("platform-chrome-tiktok")).toBeInTheDocument();
  });

  it("renders Instagram Reels wireframe chrome when platform is reels", () => {
    render(
      <SafeZoneOverlay
        fit={defaultFit}
        canvas={canvas}
        platform="reels"
        showChrome={true}
      />,
    );

    expect(screen.getByTestId("safe-zone-overlay")).toHaveAttribute(
      "data-platform",
      "reels",
    );
    expect(screen.getByTestId("platform-chrome-reels")).toBeInTheDocument();
  });

  it("renders YouTube Shorts wireframe chrome when platform is shorts", () => {
    render(
      <SafeZoneOverlay
        fit={defaultFit}
        canvas={canvas}
        platform="shorts"
        showChrome={true}
      />,
    );

    expect(screen.getByTestId("safe-zone-overlay")).toHaveAttribute(
      "data-platform",
      "shorts",
    );
    expect(screen.getByTestId("platform-chrome-shorts")).toBeInTheDocument();
  });

  it("returns null when platform is 'none'", () => {
    const { container } = render(
      <SafeZoneOverlay fit={defaultFit} canvas={canvas} platform="none" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders magnetic safe-zone snap tooltip when triggered", () => {
    render(
      <SafeZoneOverlay
        fit={defaultFit}
        canvas={canvas}
        platform="tiktok"
        snapTooltip="Snapped to TikTok safe zone"
      />,
    );

    const tooltip = screen.getByTestId("safe-zone-snap-tooltip");
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent("Snapped to TikTok safe zone");
  });
});
