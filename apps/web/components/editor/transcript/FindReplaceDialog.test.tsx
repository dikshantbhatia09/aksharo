import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Word } from "@montaj/edg";

import { FindReplaceDialog } from "./FindReplaceDialog";

function makeWords(): Word[] {
  return [
    { wid: "0:0" as never, s: 0, e: 400, t: "Dikshant", scripts: { roman: "Dikshant" } },
    { wid: "0:1" as never, s: 450, e: 800, t: "built", scripts: { roman: "built" } },
    { wid: "0:2" as never, s: 850, e: 1200, t: "Aksharo", scripts: { roman: "Aksharo" } },
    { wid: "0:3" as never, s: 1250, e: 1600, t: "Akshara", scripts: { roman: "Akshara" } },
  ];
}

describe("FindReplaceDialog", () => {
  it("renders when open and matches query", async () => {
    const onReplaceAll = vi.fn();
    render(
      <FindReplaceDialog
        open={true}
        words={makeWords()}
        script="roman"
        onClose={vi.fn()}
        onReplaceAll={onReplaceAll}
      />,
    );

    const queryInput = screen.getByTestId("find-replace-query");
    await userEvent.type(queryInput, "Akshar");

    // Both "Aksharo" and "Akshara" match substring "Akshar"
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("2 matches");

    const replacementInput = screen.getByTestId("find-replace-replacement");
    await userEvent.type(replacementInput, "Super");

    const applyButton = screen.getByTestId("find-replace-apply");
    await userEvent.click(applyButton);

    expect(onReplaceAll).toHaveBeenCalledWith([
      { wordId: "0:2", text: "Aksharo", replacement: "Super" },
      { wordId: "0:3", text: "Akshara", replacement: "Super" },
    ]);
  });

  it("filters with Whole Word matching option", async () => {
    const onReplaceAll = vi.fn();
    render(
      <FindReplaceDialog
        open={true}
        words={makeWords()}
        script="roman"
        onClose={vi.fn()}
        onReplaceAll={onReplaceAll}
      />,
    );

    const queryInput = screen.getByTestId("find-replace-query");
    await userEvent.type(queryInput, "Aksharo");

    const wholeWordSwitch = screen.getByTestId("find-replace-whole-word");
    await userEvent.click(wholeWordSwitch);

    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("1 match");

    const replacementInput = screen.getByTestId("find-replace-replacement");
    await userEvent.type(replacementInput, "AksharoPro");

    const applyButton = screen.getByTestId("find-replace-apply");
    await userEvent.click(applyButton);

    expect(onReplaceAll).toHaveBeenCalledWith([
      { wordId: "0:2", text: "Aksharo", replacement: "AksharoPro" },
    ]);
  });

  it("filters with Case Sensitive option", async () => {
    render(
      <FindReplaceDialog
        open={true}
        words={makeWords()}
        script="roman"
        onClose={vi.fn()}
        onReplaceAll={vi.fn()}
      />,
    );

    const queryInput = screen.getByTestId("find-replace-query");
    await userEvent.type(queryInput, "dikshant");

    // Case insensitive default matches "Dikshant"
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("1 match");

    const caseSensitiveSwitch = screen.getByTestId("find-replace-case-sensitive");
    await userEvent.click(caseSensitiveSwitch);

    // Case sensitive does not match "Dikshant" with "dikshant"
    expect(screen.getByTestId("find-replace-count")).toHaveTextContent("0 matches");
  });
});

