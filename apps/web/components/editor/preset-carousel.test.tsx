import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  PresetCarousel,
  VIRAL_PRESETS_METADATA,
} from "./preset-carousel";
import { BUILTIN_PRESETS } from "@montaj/caption-styles/browser";

// Mock CanvasKit renderer for StylePreviewCanvas in JSDOM environment
vi.mock("./canvas/use-canvaskit", () => ({
  useRenderer: () => ({
    backend: undefined,
    engine: undefined,
    error: undefined,
    loading: false,
  }),
}));

describe("PresetCarousel Component (Pillar 4 §06)", () => {
  it("renders the 5 gold-standard viral style preset cards", () => {
    render(<PresetCarousel />);

    expect(screen.getByTestId("preset-carousel")).toBeInTheDocument();

    for (const meta of VIRAL_PRESETS_METADATA) {
      const card = screen.getByTestId(`preset-card-${meta.key}`);
      expect(card).toBeInTheDocument();
      expect(screen.getByText(meta.title)).toBeInTheDocument();
      expect(screen.getByText(meta.badgeText)).toBeInTheDocument();

      const preset = BUILTIN_PRESETS[meta.key];
      expect(screen.getByText(preset.fontFamily)).toBeInTheDocument();
    }
  });

  it("applies the preset instantly on click emitting SetStyle op", () => {
    const onOp = vi.fn();
    const onSelectPreset = vi.fn();

    render(
      <PresetCarousel
        scope={{ kind: "doc" }}
        onOp={onOp}
        onSelectPreset={onSelectPreset}
      />,
    );

    // Click Hormozi Neon Pop
    const hormoziCard = screen.getByTestId("preset-card-hormozi_neon");
    fireEvent.click(hormoziCard);

    expect(onOp).toHaveBeenCalledTimes(1);
    const op = onOp.mock.calls[0]?.[0];
    expect(op?.op).toBe("SetStyle");
    expect(op?.scope).toBe("doc");
    expect(op?.styleRef).toBe("punch-pop");

    expect(onSelectPreset).toHaveBeenCalledTimes(1);
    const [key, preset, compiledDoc] = onSelectPreset.mock.calls[0] ?? [];
    expect(key).toBe("hormozi_neon");
    expect(preset?.name).toBe("Hormozi Neon Pop");
    expect(compiledDoc?.id).toBe("punch-pop");
    expect(compiledDoc?.typography.fontFamily).toBe("The Bold Font");
  });

  it("supports keyboard selection using Enter and Space keys", () => {
    const onOp = vi.fn();
    render(<PresetCarousel onOp={onOp} />);

    const beastCard = screen.getByTestId("preset-card-mrbeast_comic");
    fireEvent.keyDown(beastCard, { key: "Enter" });

    expect(onOp).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "SetStyle",
        styleRef: "hype-bold",
      }),
    );

    const karaokeCard = screen.getByTestId("preset-card-karaoke_cyan");
    fireEvent.keyDown(karaokeCard, { key: " " });

    expect(onOp).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "SetStyle",
        styleRef: "karaoke-fill",
      }),
    );
  });

  it("highlights selected card and renders selected checkmark badge", () => {
    const { rerender } = render(<PresetCarousel selectedStyleId="punch-pop" />);

    const hormoziCard = screen.getByTestId("preset-card-hormozi_neon");
    expect(hormoziCard).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("preset-selected-badge-hormozi_neon")).toBeInTheDocument();

    const editorialCard = screen.getByTestId("preset-card-editorial_ghost");
    expect(editorialCard).toHaveAttribute("data-selected", "false");

    // Re-render with editorial-ghost selected
    rerender(<PresetCarousel selectedStyleId="editorial-ghost-type" />);
    expect(screen.getByTestId("preset-card-editorial_ghost")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("preset-selected-badge-editorial_ghost")).toBeInTheDocument();
  });

  it("satisfies <= 50ms preset switch latency SLA", () => {
    const onOp = vi.fn();
    render(<PresetCarousel onOp={onOp} />);

    const neonCard = screen.getByTestId("preset-card-neon_pulse");

    const t0 = performance.now();
    fireEvent.click(neonCard);
    const elapsed = performance.now() - t0;

    expect(onOp).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "SetStyle",
        styleRef: "neon-glow",
      }),
    );
    expect(elapsed).toBeLessThanOrEqual(50);
  });
});
