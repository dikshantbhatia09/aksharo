import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { StyleDoc } from "@montaj/caption-styles";

import { TypographyPanel } from "./typography-panel";

const mockStyleDoc: StyleDoc = {
  id: "test-style",
  name: "Test Style",
  version: 2,
  category: "bold",
  minPlan: "free",
  typography: {
    fontFamily: "Inter",
    weight: 700,
    italic: false,
    sizePct: 5.2,
    lineHeight: 1.2,
    letterSpacingEm: 0.02,
    textTransform: "uppercase",
  },
  colors: {
    text: "#FFFFFF",
    activeText: "#FFF000",
  },
  box: {
    enabled: true,
    mode: "block",
    fill: "#000000",
    paddingPct: 20,
    radiusPct: 50,
    opacity: 0.8,
  },
  stroke: {
    enabled: true,
    color: "#000000",
    widthPct: 8,
  },
  shadow: {
    enabled: true,
    color: "#000000",
    offsetXPct: 4,
    offsetYPct: 4,
    blurPct: 10,
    opacity: 0.7,
  },
  layout: {
    anchor: "bottom-center",
    x: 50,
    y: 85,
    align: "center",
    maxWidthPct: 85,
    maxLines: 2,
  },
  animation: {
    in: { type: "pop", durationMs: 200 },
    out: { type: "fade", durationMs: 150 },
    wordHighlight: { type: "glow", durationMs: 200 },
    perWord: false,
  },
  emphasisPresets: [],
  assRenderable: false,
  assExportable: false,
  requiresLayoutMetrics: true,
};

describe("TypographyPanel (Feature 04-07)", () => {
  const defaultScope = { kind: "doc" } as const;

  it("renders the typography inspector panel with all main sections", () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    expect(screen.getByTestId("typography-panel")).toBeInTheDocument();
    expect(screen.getByText("Font & Typeface")).toBeInTheDocument();
    expect(screen.getByText("Size & Spacing")).toBeInTheDocument();
    expect(screen.getByText("Outer Stroke")).toBeInTheDocument();
    expect(screen.getByText("Shadow & Glow")).toBeInTheDocument();
    expect(screen.getByText("Background Pill")).toBeInTheDocument();
    expect(screen.getByTestId("save-brand-preset-btn")).toBeInTheDocument();
  });

  it("renders upload custom font button and file input", () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    const uploadBtn = screen.getByTestId("upload-custom-font-btn");
    const fileInput = screen.getByTestId("custom-font-file-input");

    expect(uploadBtn).toBeInTheDocument();
    expect(fileInput).toBeInTheDocument();
    expect(fileInput).toHaveAttribute("accept", ".ttf,.otf,.woff2");
  });

  it("renders granular sliders for Size, Tracking, and Leading", () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    expect(screen.getByLabelText("Font Size")).toBeInTheDocument();
    expect(screen.getByLabelText("Letter Spacing")).toBeInTheDocument();
    expect(screen.getByLabelText("Line Height")).toBeInTheDocument();
  });

  it("renders Outer Stroke width and color controls when enabled", () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    expect(screen.getByLabelText("Stroke Width")).toBeInTheDocument();
    expect(screen.getByLabelText("Stroke Color")).toBeInTheDocument();
  });

  it("renders Background Pill controls with Corner Radius", () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    expect(screen.getByLabelText("Pill Mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Pill Color")).toBeInTheDocument();
    expect(screen.getByLabelText("Pill Opacity")).toBeInTheDocument();
    expect(screen.getByLabelText("Corner Radius")).toBeInTheDocument();
  });

  it("triggers onSaveBrandKitPreset when Save as Preset button is clicked", async () => {
    const onOp = vi.fn();
    const onSaveBrandKitPreset = vi.fn();
    const user = userEvent.setup();

    render(
      <TypographyPanel
        style={mockStyleDoc}
        scope={defaultScope}
        onOp={onOp}
        onSaveBrandKitPreset={onSaveBrandKitPreset}
      />,
    );

    const saveBtn = screen.getByTestId("save-brand-preset-btn");
    await user.click(saveBtn);

    expect(onSaveBrandKitPreset).toHaveBeenCalled();
  });

  it("triggers onOp when toggling neon glow", async () => {
    const onOp = vi.fn();
    render(<TypographyPanel style={mockStyleDoc} scope={defaultScope} onOp={onOp} />);

    const glowCheckbox = screen.getByTestId("field-neon-glow");
    fireEvent.click(glowCheckbox);

    expect(onOp).toHaveBeenCalled();
  });
});
