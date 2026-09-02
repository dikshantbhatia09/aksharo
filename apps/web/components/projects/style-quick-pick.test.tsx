import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StyleQuickPick } from "./style-quick-pick";

import { renderWithProviders } from "@/test/harness";

const STYLE_DOC = {
  id: "punch-pop",
  name: "Punch Pop",
  version: 2,
  category: "bold",
  minPlan: "free",
  typography: {},
  colors: {},
  box: {},
  stroke: {},
  shadow: {},
  layout: {},
  animation: {},
  emphasisPresets: [],
  assRenderable: false,
  assExportable: false,
  requiresLayoutMetrics: true,
  presetId: "01JSTYLE0000000000000000A",
  source: "system",
  workspaceId: null,
  previewKey: "punch-pop.png",
};

describe("<StyleQuickPick />", () => {
  it("shows the selected style's name and preview once loaded", async () => {
    renderWithProviders(<StyleQuickPick styleId="punch-pop" onChange={vi.fn()} />, {
      routes: { "/styles": [STYLE_DOC] },
    });
    await waitFor(() => {
      expect(screen.getByText("Punch Pop")).toBeInTheDocument();
    });
    expect(screen.getByTestId("quick-pick-style-preview")).toHaveAttribute(
      "src",
      "/style-previews/punch-pop.png",
    );
  });

  it("prompts to choose a style before anything is picked", () => {
    renderWithProviders(<StyleQuickPick styleId={undefined} onChange={vi.fn()} />, {
      routes: { "/styles": [] },
    });
    expect(screen.getByText("Choose a style")).toBeInTheDocument();
  });

  // Opening the sheet mounts A16's real `StylePicker`, whose tiles draw
  // through `StylePreviewCanvas` (live CanvasKit previews, 08 §2). jsdom has
  // no WebGL/wasm runtime for that, which is exactly why `vitest.config.ts`
  // excludes `components/editor/**/*.tsx` from this project's own coverage
  // gate and covers them with Playwright instead (`style-preview.spec.ts`);
  // picking a style from this sheet is covered the same way, in
  // `e2e/home.spec.ts`.
});
