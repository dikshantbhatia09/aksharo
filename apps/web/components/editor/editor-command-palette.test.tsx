import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EditorCommandPalette } from "./EditorCommandPalette";

import { useCommandPalette } from "@/components/shell/command-palette";
import { type EditorActionContext } from "@/lib/editor/actions";

/**
 * The palette owns three things of its own — the Ctrl+K binding, the
 * `enabled(ctx)` filter, and the keycap rendering. Everything else it shows is
 * the registry's, and `lib/editor/actions.test.ts` already covers that, so
 * these cases deliberately do not re-assert labels or effects action by action.
 */
function makeSpies() {
  return {
    togglePlay: vi.fn(),
    jog: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    split: vi.fn(),
    mergeWithNext: vi.fn(),
    emphasize: vi.fn(),
    deleteWord: vi.fn(),
    openFind: vi.fn(),
    setHideFillers: vi.fn(),
    setFollow: vi.fn(),
    openExport: vi.fn(),
    openShare: vi.fn(),
    openRetranscribe: vi.fn(),
    openShortcuts: vi.fn(),
    goToProjects: vi.fn(),
  };
}

function spyContext(overrides: Partial<EditorActionContext> = {}): {
  readonly ctx: EditorActionContext;
  readonly spies: ReturnType<typeof makeSpies>;
} {
  const spies = makeSpies();
  return {
    spies,
    ctx: {
      canSplit: true,
      canWordEdit: true,
      hideFillers: false,
      follow: false,
      playing: false,
      ...spies,
      ...overrides,
    },
  };
}

/** The chord as the browser delivers it to a `keydown` listener. */
function pressCtrlK(target: Window | Element): void {
  fireEvent.keyDown(target, { key: "k", ctrlKey: true });
}

describe("<EditorCommandPalette />", () => {
  it("opens on Ctrl+K, closes on Escape, and ignores the chord while typing", async () => {
    const user = userEvent.setup();
    const { ctx } = spyContext();
    render(
      <>
        <input data-testid="somewhere-to-type" />
        <EditorCommandPalette ctx={ctx} />
      </>,
    );

    expect(screen.queryByTestId("editor-palette-list")).toBeNull();

    pressCtrlK(window);
    expect(await screen.findByTestId("editor-palette-list")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("editor-palette-list")).toBeNull();
    });

    // `isTextEntryTarget`: a text field owns its own Ctrl+K (and the user is
    // mid-word), so the palette stays shut.
    pressCtrlK(screen.getByTestId("somewhere-to-type"));
    expect(screen.queryByTestId("editor-palette-list")).toBeNull();
  });

  it("takes Ctrl+K in the capture phase so the shell's palette never sees it", () => {
    const bubbled = vi.fn();
    window.addEventListener("keydown", bubbled); // the shell's listener, line-for-line
    try {
      const { ctx } = spyContext();
      render(<EditorCommandPalette ctx={ctx} />);
      pressCtrlK(document.body);
      expect(bubbled).not.toHaveBeenCalled();

      // …and only for its own chord: everything else still reaches the shell.
      fireEvent.keyDown(document.body, { key: "j" });
      expect(bubbled).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", bubbled);
    }
  });

  /**
   * The shell's OWN hook, not a copy of it: `AppShell` mounts
   * `useCommandPalette()` on every `(app)` route, `/p/[id]` included, so on the
   * editor screen both listeners are live. "One Ctrl+K, one palette" has to
   * hold for every target the chord can be pressed on — including the text
   * surfaces, where the editor palette declines to open but the shell's
   * unguarded listener would happily answer instead.
   */
  it("swallows Ctrl+K on every target, so the shell's palette never answers it in the editor", async () => {
    function Both({ ctx }: { readonly ctx: EditorActionContext }): React.JSX.Element {
      const shell = useCommandPalette();
      return (
        <>
          <span data-testid="shell-state">{shell.open ? "open" : "closed"}</span>
          <span data-testid="a-word" contentEditable suppressContentEditableWarning>
            word
          </span>
          <EditorCommandPalette ctx={ctx} />
        </>
      );
    }

    const { ctx } = spyContext();
    render(<Both ctx={ctx} />);
    const shellState = () => screen.getByTestId("shell-state").textContent;

    // 1. Opening it: the shell must not see the chord.
    pressCtrlK(window);
    expect(await screen.findByTestId("editor-palette-list")).toBeInTheDocument();
    expect(shellState()).toBe("closed");

    // 2. Palette open: cmdk's input has focus, so the chord is a text-entry
    //    target. The editor palette declines it — and the shell must not get it.
    pressCtrlK(screen.getByTestId("editor-palette-input"));
    expect(shellState()).toBe("closed");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("editor-palette-list")).toBeNull();
    });

    // 3. Mid-word-edit in a contenteditable chip: typing wins, so no palette
    //    opens — neither ours nor, crucially, the shell's.
    pressCtrlK(screen.getByTestId("a-word"));
    expect(screen.queryByTestId("editor-palette-list")).toBeNull();
    expect(shellState()).toBe("closed");
  });

  it("runs the action the search found, exactly once, and closes", async () => {
    const user = userEvent.setup();
    const { ctx, spies } = spyContext();
    render(<EditorCommandPalette ctx={ctx} />);

    pressCtrlK(window);
    const input = await screen.findByTestId("editor-palette-input");
    await user.type(input, "merge");

    expect(screen.getByTestId("palette-edit.merge")).toBeInTheDocument();
    expect(screen.queryByTestId("palette-edit.undo")).toBeNull();

    await user.keyboard("{Enter}");

    expect(spies.mergeWithNext).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("editor-palette-list")).toBeNull();
    });
  });

  it("omits an action that cannot run, where the menubar would show it disabled", async () => {
    const { ctx } = spyContext({ canSplit: false });
    render(<EditorCommandPalette ctx={ctx} />);

    pressCtrlK(window);
    await screen.findByTestId("editor-palette-list");

    expect(screen.queryByTestId("palette-edit.split")).toBeNull();
    expect(screen.queryByTestId("palette-edit.merge")).toBeNull();
    // The word actions are gated on their own flag, which is still true.
    expect(screen.getByTestId("palette-edit.deleteWord")).toBeInTheDocument();
  });

  it("draws a chord as one keycap per key", async () => {
    const { ctx } = spyContext();
    render(<EditorCommandPalette ctx={ctx} />);

    pressCtrlK(window);
    await screen.findByTestId("editor-palette-list");

    const undo = within(screen.getByTestId("palette-edit.undo"));
    expect(undo.getAllByText("Ctrl")).toHaveLength(1);
    expect(undo.getAllByText("Z")).toHaveLength(1);
    expect(screen.getByTestId("palette-edit.undo").querySelectorAll("kbd")).toHaveLength(2);
    // "Ctrl+Z" must not arrive as a single cap.
    expect(undo.queryByText("Ctrl+Z")).toBeNull();
  });
});
