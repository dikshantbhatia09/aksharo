import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Segment, Word } from "@montaj/edg";

import { TranscriptEditor } from "./transcript-editor";

function makeWord(wid: string, text: string, s: number, e: number): Word {
  return {
    wid: wid as never,
    s,
    e,
    t: text,
  };
}

function makeSegment(id: string, startMs: number, endMs: number, words: Word[]): Segment {
  return {
    id,
    startMs,
    endMs,
    words,
  } as unknown as Segment;
}

describe("TranscriptEditor", () => {
  const wordsSeg1 = [
    makeWord("0:0", "Hello", 0, 500),
    makeWord("0:1", "world", 500, 1000),
  ];
  const wordsSeg2 = [
    makeWord("1:0", "Second", 1000, 1500),
    makeWord("1:1", "line", 1500, 2000),
  ];

  const segments: Segment[] = [
    makeSegment("seg-1", 0, 1000, wordsSeg1),
    makeSegment("seg-2", 1000, 2000, wordsSeg2),
  ];

  const wordsOf = (seg: Segment): readonly Word[] => {
    return (seg as unknown as { words: Word[] }).words;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders caption cards with formatted timestamps and words", () => {
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
      />,
    );

    expect(screen.getByTestId("caption-card-seg-1")).toBeInTheDocument();
    expect(screen.getByTestId("caption-card-seg-2")).toBeInTheDocument();
    expect(screen.getByTestId("editable-word-chip-0:0")).toHaveTextContent("Hello");
    expect(screen.getByTestId("editable-word-chip-0:1")).toHaveTextContent("world");
    expect(screen.getByTestId("editable-word-chip-1:0")).toHaveTextContent("Second");
    expect(screen.getByTestId("editable-word-chip-1:1")).toHaveTextContent("line");
  });

  it("calls onSeek when a timestamp is clicked", () => {
    const onSeek = vi.fn();
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
        onSeek={onSeek}
      />,
    );

    fireEvent.click(screen.getByTestId("caption-seek-seg-1"));
    expect(onSeek).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByTestId("caption-seek-seg-2"));
    expect(onSeek).toHaveBeenCalledWith(1000);
  });

  it("calls onFindReplaceClick when find & replace button is clicked", () => {
    const onFindReplace = vi.fn();
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
        onFindReplaceClick={onFindReplace}
      />,
    );

    fireEvent.click(screen.getByTestId("transcript-editor-find-replace"));
    expect(onFindReplace).toHaveBeenCalledTimes(1);
  });

  it("edits a word in place with immediate onWordUpdate and debounced fetch sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const onWordUpdate = vi.fn();
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
        onWordUpdate={onWordUpdate}
      />,
    );

    // Click to enter edit mode
    fireEvent.click(screen.getByTestId("editable-word-chip-0:0"));
    const input = screen.getByTestId("editable-word-input-0:0") as HTMLInputElement;
    expect(input).toBeInTheDocument();

    // Type new text
    act(() => {
      fireEvent.change(input, { target: { value: "Namaste" } });
      fireEvent.blur(input);
    });

    // Immediate callback (<= 16ms)
    expect(onWordUpdate).toHaveBeenCalledWith("0:0", "Namaste");

    // Before debounce timer fires
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance 500ms debounce
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/transcripts/tx-1/words/0%3A0",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ text: "Namaste" }),
      }),
    );
  });

  it("supports Tab and Shift+Tab navigation between words", () => {
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
      />,
    );

    const chip1 = screen.getByTestId("editable-word-chip-0:0");
    fireEvent.click(chip1);

    const input1 = screen.getByTestId("editable-word-input-0:0");
    // Press Tab
    fireEvent.keyDown(input1, { key: "Tab" });

    // Focus moved to next word "0:1"
    expect(screen.getByTestId("editable-word-chip-0:1")).toHaveClass("ring-1");
  });

  it("splits a line when pressing Shift+Enter on a word", () => {
    const onSplitLine = vi.fn();
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
        onSplitLine={onSplitLine}
      />,
    );

    const chip = screen.getByTestId("editable-word-chip-0:1");
    fireEvent.keyDown(chip, { key: "Enter", shiftKey: true });

    expect(onSplitLine).toHaveBeenCalledWith("seg-1", "0:1");
  });

  it("merges lines when clicking the merge button or pressing Backspace on first word", () => {
    const onMergeLine = vi.fn();
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
        onMergeLine={onMergeLine}
      />,
    );

    // Click merge button on second segment
    fireEvent.click(screen.getByTestId("merge-line-seg-2"));
    expect(onMergeLine).toHaveBeenCalledWith("seg-1");

    // Or press Backspace on first word of second segment
    const firstWordSeg2 = screen.getByTestId("editable-word-chip-1:0");
    fireEvent.keyDown(firstWordSeg2, { key: "Backspace" });
    expect(onMergeLine).toHaveBeenCalledWith("seg-1");
  });

  it("toggles auto-scroll checkbox", () => {
    render(
      <TranscriptEditor
        transcriptId="tx-1"
        segments={segments}
        wordsOf={wordsOf}
      />,
    );

    const checkbox = screen.getByTestId("transcript-editor-follow") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });
});
