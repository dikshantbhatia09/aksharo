import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Segment, Word } from "@montaj/edg";

import { SegmentCard } from "./SegmentCard";

/**
 * OC3: the card's right-click menu. It replaced a hand-rolled `onContextMenu`
 * that opened a two-button popover for the word under the pointer, so the
 * insert-word-after case that test file owned moved here with it — the menu is
 * now the only way to reach that operation.
 *
 * The menu never implements an operation: every row calls the callback the
 * card already had, or reports the action to the editor through
 * `onRequestAction` for the three ops the editor owns (split, emphasise,
 * delete word). These tests therefore assert the *wiring*, which is the only
 * thing this component decides.
 */
function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "s1",
    seq: "V",
    startWordId: "0:0" as never,
    endWordId: "0:1" as never,
    startMs: 61_000,
    endMs: 62_000,
    ...overrides,
  };
}

const WORDS: Word[] = [
  { wid: "0:0" as never, s: 61_000, e: 61_400, t: "hello", sp: "sp1" },
  { wid: "0:1" as never, s: 61_400, e: 62_000, t: "world", sp: "sp1" },
];

function baseProps() {
  return {
    segment: segment(),
    index: 1,
    words: WORDS,
    script: "roman" as const,
    onEditWord: vi.fn(),
    onInsertWordAfter: vi.fn(),
  };
}

/** Right-click the card itself — no word under the pointer. */
function openOnCard(): void {
  fireEvent.contextMenu(screen.getByTestId("segment-card-s1"), { clientX: 8, clientY: 12 });
}

/** Right-click a word, pointer-down first exactly as a browser sends it. */
function openOnWord(wordId: string): void {
  const chip = screen.getByTestId(`word-chip-${wordId}`);
  fireEvent.pointerDown(chip, { button: 2 });
  fireEvent.contextMenu(chip, { clientX: 8, clientY: 12 });
}

describe("SegmentCard context menu", () => {
  it("right-clicking the card opens the segment menu", async () => {
    render(<SegmentCard {...baseProps()} />);
    expect(screen.queryByTestId("segment-context-menu")).toBeNull();

    openOnCard();
    expect(await screen.findByTestId("segment-context-menu")).toBeInTheDocument();
  });

  it("Merge with next fires the card's own callback with this segment's id", async () => {
    const onMergeWithNext = vi.fn();
    const user = userEvent.setup();
    render(<SegmentCard {...baseProps()} onMergeWithNext={onMergeWithNext} />);

    openOnCard();
    await user.click(await screen.findByTestId("segment-menu-merge"));
    expect(onMergeWithNext).toHaveBeenCalledWith("s1");
  });

  it("the destructive row is disabled while no word is the menu's target", async () => {
    const onRequestAction = vi.fn();
    const user = userEvent.setup();
    render(<SegmentCard {...baseProps()} onRequestAction={onRequestAction} />);

    openOnCard();
    const del = await screen.findByTestId("segment-menu-delete-word");
    expect(del).toHaveAttribute("data-disabled");
    expect(del.className).toContain("text-rejected");

    await user.click(del);
    expect(onRequestAction).not.toHaveBeenCalled();
  });

  it("right-clicking a word targets that word for the editor-level actions", async () => {
    const onRequestAction = vi.fn();
    const user = userEvent.setup();
    render(<SegmentCard {...baseProps()} onRequestAction={onRequestAction} />);

    openOnWord("0:1");
    await user.click(await screen.findByTestId("segment-menu-delete-word"));
    expect(onRequestAction).toHaveBeenCalledWith("deleteWord", "s1", "0:1");
  });

  it("Split here reports the right-clicked word to the editor", async () => {
    const onRequestAction = vi.fn();
    const user = userEvent.setup();
    render(<SegmentCard {...baseProps()} onRequestAction={onRequestAction} />);

    openOnWord("0:0");
    await user.click(await screen.findByTestId("segment-menu-split"));
    expect(onRequestAction).toHaveBeenCalledWith("split", "s1", "0:0");
  });

  it("falls back to the selected word, but only when it belongs to this card", async () => {
    const onRequestAction = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SegmentCard {...baseProps()} selectedWordId="0:1" onRequestAction={onRequestAction} />,
    );

    openOnCard();
    await user.click(await screen.findByTestId("segment-menu-emphasise"));
    expect(onRequestAction).toHaveBeenCalledWith("emphasize", "s1", "0:1");

    // A word selected in some other segment must not enable this card's rows.
    rerender(
      <SegmentCard {...baseProps()} selectedWordId="9:9" onRequestAction={onRequestAction} />,
    );
    openOnCard();
    expect(await screen.findByTestId("segment-menu-emphasise")).toHaveAttribute("data-disabled");
  });

  it("hide reads the segment's real hidden state", async () => {
    const onHideToggle = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<SegmentCard {...baseProps()} onHideToggle={onHideToggle} />);

    openOnCard();
    const hide = await screen.findByTestId("segment-menu-hide");
    expect(hide).toHaveTextContent("Hide segment");
    await user.click(hide);
    expect(onHideToggle).toHaveBeenCalledWith("s1", true);

    rerender(
      <SegmentCard
        {...baseProps()}
        segment={segment({ hidden: true })}
        onHideToggle={onHideToggle}
      />,
    );
    openOnCard();
    expect(await screen.findByTestId("segment-menu-hide")).toHaveTextContent("Show segment");
  });

  it("insert word after still runs on the right-clicked word (was the old popover)", async () => {
    const onInsertWordAfter = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, "prompt").mockReturnValue("brand");
    render(<SegmentCard {...baseProps()} onInsertWordAfter={onInsertWordAfter} />);

    openOnWord("0:0");
    await user.click(await screen.findByTestId("segment-menu-insert-word"));
    expect(onInsertWordAfter).toHaveBeenCalledWith("0:0", "brand");
  });

  it("fix spelling everywhere sends the text the chip is showing", async () => {
    const onFixSpellingEverywhere = vi.fn();
    const user = userEvent.setup();
    render(<SegmentCard {...baseProps()} onFixSpellingEverywhere={onFixSpellingEverywhere} />);

    openOnWord("0:1");
    await user.click(await screen.findByTestId("segment-menu-fix-spelling"));
    expect(onFixSpellingEverywhere).toHaveBeenCalledWith("0:1", "world");
  });

  it("merge is disabled on the last segment, matching the card's own button", async () => {
    render(<SegmentCard {...baseProps()} onMergeWithNext={vi.fn()} isLast />);

    openOnCard();
    expect(await screen.findByTestId("segment-menu-merge")).toHaveAttribute("data-disabled");
  });
});
