import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Segment, Word } from "@montaj/edg";

import { TranscriptList } from "./TranscriptList";

const WORDS: Word[] = [
  { wid: "0:0" as never, s: 0, e: 400, t: "bheeg", sp: "sp1" },
  { wid: "0:1" as never, s: 400, e: 800, t: "rahe", sp: "sp1" },
  { wid: "0:2" as never, s: 800, e: 1_200, t: "lekin", sp: "sp1" },
  { wid: "0:3" as never, s: 1_200, e: 1_600, t: "aapko", sp: "sp1" },
];

function wordsBetween(startWordId: string, endWordId: string): Word[] {
  const start = WORDS.findIndex((w) => w.wid === startWordId);
  const end = WORDS.findIndex((w) => w.wid === endWordId);
  return WORDS.slice(start, end + 1);
}

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "s1",
    seq: "V",
    startWordId: "0:0" as never,
    endWordId: "0:3" as never,
    startMs: 0,
    endMs: 1_600,
    ...overrides,
  };
}

function baseProps() {
  return {
    script: "roman" as const,
    onSelectSegment: vi.fn(),
    onEditWord: vi.fn(),
    onInsertWordAfter: vi.fn(),
  };
}

describe("TranscriptList", () => {
  it("does not keep showing a segment's pre-split words once it has been split, even when `wordsOf`'s own identity is unchanged", () => {
    // `wordsOf` is stable across both renders below — exactly what happens in
    // the real editor, where it is memoized on `state.words` alone
    // (editor-client.tsx), and a `SplitSegment`/`MergeSegments`/`Resegment`
    // op changes segment boundaries without touching the word index itself.
    const wordsOf = vi.fn((seg: Segment) => wordsBetween(seg.startWordId, seg.endWordId));

    const { rerender } = render(
      <TranscriptList {...baseProps()} segments={[segment()]} wordsOf={wordsOf} />,
    );
    const originalCard = screen.getByTestId("segment-card-s1");
    expect(within(originalCard).getByTestId("word-chip-0:2")).toHaveTextContent("lekin");
    expect(within(originalCard).getByTestId("word-chip-0:3")).toHaveTextContent("aapko");

    // Simulate a split: "s1" is trimmed to its first two words and a new
    // segment "s2" takes the rest — same `wordsOf` function reference.
    rerender(
      <TranscriptList
        {...baseProps()}
        segments={[
          segment({ startWordId: "0:0" as never, endWordId: "0:1" as never, endMs: 800 }),
          segment({
            id: "s2",
            startWordId: "0:2" as never,
            endWordId: "0:3" as never,
            startMs: 800,
            endMs: 1_600,
          }),
        ]}
        wordsOf={wordsOf}
      />,
    );

    const splitCard = screen.getByTestId("segment-card-s1");
    expect(within(splitCard).queryByTestId("word-chip-0:2")).not.toBeInTheDocument();
    expect(within(splitCard).queryByTestId("word-chip-0:3")).not.toBeInTheDocument();

    const newCard = screen.getByTestId("segment-card-s2");
    expect(within(newCard).getByTestId("word-chip-0:2")).toHaveTextContent("lekin");
    expect(within(newCard).getByTestId("word-chip-0:3")).toHaveTextContent("aapko");
  });

  it("still reuses a cached word list for a segment whose boundaries have not changed", () => {
    const wordsOf = vi.fn((seg: Segment) => wordsBetween(seg.startWordId, seg.endWordId));
    const { rerender } = render(
      <TranscriptList {...baseProps()} segments={[segment()]} wordsOf={wordsOf} />,
    );
    wordsOf.mockClear();
    rerender(<TranscriptList {...baseProps()} segments={[segment()]} wordsOf={wordsOf} />);
    expect(wordsOf).not.toHaveBeenCalled();
  });
});
