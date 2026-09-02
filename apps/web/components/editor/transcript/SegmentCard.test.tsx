import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Segment, Word } from "@montaj/edg";

import { SegmentCard } from "./SegmentCard";

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
    words: WORDS,
    script: "roman" as const,
    onEditWord: vi.fn(),
    onInsertWordAfter: vi.fn(),
  };
}

describe("SegmentCard", () => {
  it("renders the speaker chip, the timestamp and every word", () => {
    render(<SegmentCard {...baseProps()} />);
    expect(screen.getByTestId("speaker-chip-sp1")).toBeInTheDocument();
    expect(screen.getByTestId("segment-timestamp-s1")).toHaveTextContent("01:01");
    expect(screen.getByTestId("word-chip-0:0")).toHaveTextContent("hello");
    expect(screen.getByTestId("word-chip-0:1")).toHaveTextContent("world");
  });

  it("clicking the card selects the segment", async () => {
    const onSelect = vi.fn();
    render(<SegmentCard {...baseProps()} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId("segment-card-s1"));
    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("clicking the timestamp seeks without selecting the segment via bubbling twice", async () => {
    const onSeek = vi.fn();
    render(<SegmentCard {...baseProps()} onSeek={onSeek} />);
    await userEvent.click(screen.getByTestId("segment-timestamp-s1"));
    expect(onSeek).toHaveBeenCalledWith(61_000);
  });

  it("the hide button toggles based on the current hidden state", async () => {
    const onHideToggle = vi.fn();
    const { rerender } = render(<SegmentCard {...baseProps()} onHideToggle={onHideToggle} />);
    expect(screen.getByTestId("segment-hide-s1")).toHaveTextContent("Hide");
    await userEvent.click(screen.getByTestId("segment-hide-s1"));
    expect(onHideToggle).toHaveBeenCalledWith("s1", true);

    rerender(
      <SegmentCard
        {...baseProps()}
        segment={segment({ hidden: true })}
        onHideToggle={onHideToggle}
      />,
    );
    expect(screen.getByTestId("segment-hide-s1")).toHaveTextContent("Show");
  });

  it("the merge-with-next button is absent on the last segment", () => {
    const { rerender } = render(<SegmentCard {...baseProps()} onMergeWithNext={vi.fn()} />);
    expect(screen.getByTestId("segment-merge-next-s1")).toBeInTheDocument();

    rerender(<SegmentCard {...baseProps()} onMergeWithNext={vi.fn()} isLast />);
    expect(screen.queryByTestId("segment-merge-next-s1")).not.toBeInTheDocument();
  });

  it("clicking a word reports its selection scoped to this segment", async () => {
    const onSelectWord = vi.fn();
    render(<SegmentCard {...baseProps()} onSelectWord={onSelectWord} />);
    await userEvent.click(screen.getByTestId("word-chip-0:0"));
    expect(onSelectWord).toHaveBeenCalledWith("s1", "0:0");
  });

  it("right-clicking a word opens the insert-after menu, and confirming calls onInsertWordAfter", async () => {
    const onInsertWordAfter = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(window, "prompt").mockReturnValue("brand");
    render(<SegmentCard {...baseProps()} onInsertWordAfter={onInsertWordAfter} />);

    const chip = screen.getByTestId("word-chip-0:0");
    await user.pointer({ keys: "[MouseRight]", target: chip });
    expect(screen.getByTestId("word-insert-menu-0:0")).toBeInTheDocument();

    await user.click(screen.getByTestId("word-insert-after-0:0"));
    expect(onInsertWordAfter).toHaveBeenCalledWith("0:0", "brand");
  });

  it("a hidden segment is visually de-emphasised", () => {
    render(<SegmentCard {...baseProps()} segment={segment({ hidden: true })} />);
    expect(screen.getByTestId("segment-card-s1").className).toMatch(/opacity-40/);
  });
});
