import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Word } from "@montaj/edg";

import { WordChip } from "./WordChip";

function word(overrides: Partial<Word> = {}): Word {
  return { wid: "0:0" as never, s: 0, e: 500, t: "hello", ...overrides };
}

describe("WordChip", () => {
  it("renders the word for the requested script", () => {
    render(
      <WordChip word={word({ scripts: { roman: "namaste" } })} script="roman" onCommit={vi.fn()} />,
    );
    expect(screen.getByTestId("word-chip-0:0")).toHaveTextContent("namaste");
  });

  it("falls back to the base text when the script has no override", () => {
    render(<WordChip word={word()} script="native" onCommit={vi.fn()} />);
    expect(screen.getByTestId("word-chip-0:0")).toHaveTextContent("hello");
  });

  it("a click selects and seeks to the word's start", async () => {
    const onSelect = vi.fn();
    const onSeek = vi.fn();
    render(
      <WordChip
        word={word()}
        script="roman"
        onCommit={vi.fn()}
        onSelect={onSelect}
        onSeek={onSeek}
      />,
    );
    await userEvent.click(screen.getByTestId("word-chip-0:0"));
    expect(onSelect).toHaveBeenCalledWith("0:0");
    expect(onSeek).toHaveBeenCalledWith(0);
  });

  it("a double-click fires onFixSpellingEverywhere with the word's id and text, not edit mode", async () => {
    const onFix = vi.fn();
    render(
      <WordChip word={word()} script="roman" onCommit={vi.fn()} onFixSpellingEverywhere={onFix} />,
    );
    const chip = screen.getByTestId("word-chip-0:0");
    fireEvent.doubleClick(chip);
    expect(onFix).toHaveBeenCalledWith("0:0", "hello");
    expect(chip).not.toHaveAttribute("contenteditable", "true");
  });

  it("Enter enters edit mode, and a second Enter commits the edited text", () => {
    const onCommit = vi.fn();
    render(<WordChip word={word()} script="roman" onCommit={onCommit} />);
    const chip = screen.getByTestId("word-chip-0:0");
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(chip).toHaveAttribute("contenteditable", "true");

    chip.textContent = "hullo";
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("0:0", "hullo");
  });

  it("Escape cancels an edit without committing", () => {
    const onCommit = vi.fn();
    render(<WordChip word={word()} script="roman" onCommit={onCommit} />);
    const chip = screen.getByTestId("word-chip-0:0");
    fireEvent.keyDown(chip, { key: "Enter" });
    chip.textContent = "changed";
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blurring mid-edit commits, and an unchanged value does not call onCommit", () => {
    const onCommit = vi.fn();
    render(<WordChip word={word()} script="roman" onCommit={onCommit} />);
    const chip = screen.getByTestId("word-chip-0:0");
    fireEvent.keyDown(chip, { key: "Enter" });
    fireEvent.blur(chip);
    expect(onCommit).not.toHaveBeenCalled(); // text unchanged
  });

  it("a filler word is dimmed by default and hidden entirely when hideFillers is set", () => {
    const { rerender } = render(
      <WordChip word={word({ filler: true })} script="roman" onCommit={vi.fn()} />,
    );
    expect(screen.getByTestId("word-chip-0:0")).toHaveAttribute("data-filler", "true");

    rerender(
      <WordChip word={word({ filler: true })} script="roman" onCommit={vi.fn()} hideFillers />,
    );
    expect(screen.queryByTestId("word-chip-0:0")).not.toBeInTheDocument();
  });

  it("a low-confidence word is underlined amber", () => {
    render(<WordChip word={word({ c: 0.2 })} script="roman" onCommit={vi.fn()} />);
    expect(screen.getByTestId("word-chip-0:0").className).toMatch(/decoration-amber-400/);
  });

  it("a confident word is not underlined", () => {
    render(<WordChip word={word({ c: 0.95 })} script="roman" onCommit={vi.fn()} />);
    expect(screen.getByTestId("word-chip-0:0").className).not.toMatch(/decoration-amber-400/);
  });
});
