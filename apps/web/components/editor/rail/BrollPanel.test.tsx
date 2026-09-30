import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { BRollOverlay } from "@montaj/edg";

import { BrollPanel, brollTime, type BrollPanelProps } from "./BrollPanel";

import type { BrollLibraryView, BrollPicture } from "@/components/broll/use-broll-library";

import { renderWithProviders } from "@/test/harness";

const WORDS = ["Kal", "hum", "Agra", "gaye", "aur", "Taj", "Mahal", "dekha", "phir", "chai"].map(
  (t, index) => ({ wid: `0:${String(index)}`, t, s: index * 1_000, e: index * 1_000 + 800 }),
);

const TAJ: BrollPicture = {
  assetId: "01JPX0000000000000000000T1",
  format: "jpeg",
  contentType: "image/jpeg",
  width: 1440,
  height: 2560,
  sizeBytes: 400_000,
  tags: ["taj mahal"],
  title: "Taj at dawn",
  source: "upload",
  credit: null,
  url: "https://cdn.test/taj.jpg",
  createdAt: "2026-10-05T09:00:00.000Z",
};

const LIBRARY: BrollLibraryView = {
  items: [TAJ],
  stock: { enabled: false, provider: null },
  limits: {
    maxBytes: 8 * 1024 * 1024,
    contentTypes: ["image/jpeg"],
    minSide: 320,
    maxSide: 3840,
    uploadLongSide: 2560,
    maxAssets: 300,
    maxTags: 10,
    tagMax: 40,
    titleMax: 120,
  },
};

const CUTAWAY: BRollOverlay = {
  id: "01JBR0000000000000000000A1",
  kind: "b-roll",
  startMs: 5_000,
  endMs: 7_800,
  image: { assetId: TAJ.assetId, format: "jpeg", width: 1440, height: 2560 },
  mode: "full",
  motion: "push-in",
  startWordId: "0:5",
  endWordId: "0:7",
  label: "Taj at dawn",
};

function props(overrides: Partial<BrollPanelProps> = {}): BrollPanelProps {
  return {
    cutaways: [CUTAWAY],
    words: WORDS,
    addAt: { word: "phir", startMs: 8_000 },
    library: LIBRARY,
    canvas: { width: 1080, height: 1920 },
    canEdit: true,
    placementProblem: () => undefined,
    onAdd: vi.fn(),
    onChange: vi.fn(),
    onRemove: vi.fn(),
    onSeek: vi.fn(),
    ...overrides,
  };
}

describe("<BrollPanel />", () => {
  it("adds a library picture at the word under the playhead", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    renderWithProviders(<BrollPanel {...props({ onAdd })} />);
    expect(screen.getByText("Add at “phir” 0:08.0")).toBeInTheDocument();
    await user.click(screen.getByTestId(`broll-pick-${TAJ.assetId}`));
    expect(onAdd).toHaveBeenCalledWith(TAJ);
    // No stock photos in this deployment: no way to ask for one.
    expect(screen.queryByTestId("broll-source-stock")).not.toBeInTheDocument();
  });

  it("will not add over the hook, and says why", () => {
    renderWithProviders(
      <BrollPanel {...props({ addAt: { word: "Kal", startMs: 0, problem: "hook" } })} />,
    );
    expect(screen.getByTestId("broll-add-problem")).toHaveTextContent("the hook's");
    expect(screen.getByTestId(`broll-pick-${TAJ.assetId}`)).toBeDisabled();
  });

  it("switches a cutaway between full frame and a box, and its motion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<BrollPanel {...props({ onChange })} />);
    await user.click(screen.getByTestId(`broll-mode-pip-${CUTAWAY.id}`));
    expect(onChange).toHaveBeenLastCalledWith({ ...CUTAWAY, mode: "pip" }, "Change B-roll size");
    await user.selectOptions(screen.getByTestId(`broll-motion-${CUTAWAY.id}`), "pan-left");
    expect(onChange).toHaveBeenLastCalledWith(
      { ...CUTAWAY, motion: "pan-left" },
      "Change B-roll motion",
    );
  });

  it("moves and trims a word at a time, and never where it may not go", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <BrollPanel
        {...props({
          onChange,
          // A title from 8.5 s: moving later would run into it.
          placementProblem: (window) => (window.endMs > 8_500 ? "title" : undefined),
        })}
      />,
    );
    expect(screen.getByTestId(`broll-move-later-${CUTAWAY.id}`)).toBeDisabled();
    await user.click(screen.getByTestId(`broll-move-earlier-${CUTAWAY.id}`));
    expect(onChange).toHaveBeenLastCalledWith(
      { ...CUTAWAY, startMs: 4_000, endMs: 6_800, startWordId: "0:4", endWordId: "0:6" },
      "Move B-roll",
    );
    await user.click(screen.getByTestId(`broll-trim-end-earlier-${CUTAWAY.id}`));
    expect(onChange).toHaveBeenLastCalledWith(
      { ...CUTAWAY, endMs: 6_800, startWordId: "0:5", endWordId: "0:6" },
      "Trim B-roll",
    );
  });

  it("removes a cutaway, seeks to it, and says when its picture has gone", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const onSeek = vi.fn();
    renderWithProviders(
      <BrollPanel {...props({ onRemove, onSeek, library: { ...LIBRARY, items: [] } })} />,
    );
    expect(screen.getByTestId(`broll-cutaway-gone-${CUTAWAY.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("broll-library-empty")).toHaveTextContent("empty");
    await user.click(screen.getByTestId(`broll-cutaway-seek-${CUTAWAY.id}`));
    expect(onSeek).toHaveBeenCalledWith(5_000);
    await user.click(screen.getByTestId(`broll-remove-${CUTAWAY.id}`));
    expect(onRemove).toHaveBeenCalledWith(CUTAWAY);
  });

  it("offers stock photos where the deployment has them", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BrollPanel
        {...props({ library: { ...LIBRARY, stock: { enabled: true, provider: "pexels" } } })}
      />,
    );
    await user.click(screen.getByTestId("broll-source-stock"));
    expect(screen.getByTestId("broll-editor-stock-query")).toBeInTheDocument();
    expect(screen.getByText("Pexels")).toHaveAttribute("href", "https://www.pexels.com");
  });

  it("reads times the way the timeline does", () => {
    expect(brollTime(0)).toBe("0:00.0");
    expect(brollTime(65_430)).toBe("1:05.4");
  });
});
