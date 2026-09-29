import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { cleanHookText, HookTitleField, type HookTitleOverlay } from "./HookTitleField";

const HOOK: HookTitleOverlay = {
  id: "01JHOOK0000000000000000000",
  kind: "hook-title",
  text: "Paisa bachana easy hai",
  startMs: 0,
  endMs: 2_500,
};

function renderField(overlay: HookTitleOverlay = HOOK) {
  const onChangeText = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <HookTitleField overlay={overlay} onChangeText={onChangeText} onRemove={onRemove} />,
  );
  return { onChangeText, onRemove, view };
}

describe("HookTitleField", () => {
  it("shows the hook's words and commits a new wording once, on Enter", async () => {
    const { onChangeText } = renderField();
    const input = screen.getByTestId("hook-title-input");
    expect(input).toHaveValue("Paisa bachana easy hai");

    await userEvent.clear(input);
    await userEvent.type(input, "  Ye   galti mat karna {Enter}");
    expect(onChangeText).toHaveBeenCalledTimes(1);
    expect(onChangeText).toHaveBeenCalledWith("Ye galti mat karna");
  });

  it("sends nothing when the words did not change, and puts them back when emptied", async () => {
    const { onChangeText } = renderField();
    const input = screen.getByTestId("hook-title-input");
    fireEvent.blur(input);
    expect(onChangeText).not.toHaveBeenCalled();

    await userEvent.clear(input);
    fireEvent.blur(input);
    expect(onChangeText).not.toHaveBeenCalled();
    expect(input).toHaveValue("Paisa bachana easy hai");
  });

  it("follows an edit made elsewhere (an undo)", () => {
    const { view } = renderField();
    view.rerender(
      <HookTitleField
        overlay={{ ...HOOK, text: "Undone words" }}
        onChangeText={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByTestId("hook-title-input")).toHaveValue("Undone words");
  });

  it("removes the title from its own button", async () => {
    const { onRemove } = renderField();
    await userEvent.click(screen.getByTestId("hook-title-remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("cleanHookText", () => {
  it("collapses spaces, trims, and caps the length the document allows", () => {
    expect(cleanHookText("  a \n b  ")).toBe("a b");
    expect(cleanHookText("x".repeat(200))).toHaveLength(120);
  });
});
