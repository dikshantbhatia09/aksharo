import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_ACTIONS,
  EDITOR_MENUS,
  type EditorAction,
  type EditorActionContext,
} from "./actions";

/**
 * A context whose every function is a spy, so "action `x` runs exactly the
 * context function it claims to" is a property the whole registry is checked
 * against in a loop rather than one assertion per action — the point of
 * ARCHITECTURE §6 being that a *new* action gets this coverage for free.
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

type Spies = ReturnType<typeof makeSpies>;

function spyContext(overrides: Partial<EditorActionContext> = {}): {
  readonly ctx: EditorActionContext;
  readonly spies: Spies;
} {
  const spies = makeSpies();
  return {
    spies,
    ctx: {
      canSplit: false,
      canWordEdit: false,
      hideFillers: false,
      follow: false,
      playing: false,
      ...spies,
      ...overrides,
    },
  };
}

/** id → the single context function that action is contracted to call. */
const EXPECTED_EFFECT: Record<string, keyof Spies> = {
  "file.projects": "goToProjects",
  "file.export": "openExport",
  "file.share": "openShare",
  "edit.undo": "undo",
  "edit.redo": "redo",
  "edit.split": "split",
  "edit.merge": "mergeWithNext",
  "edit.emphasize": "emphasize",
  "edit.deleteWord": "deleteWord",
  "edit.find": "openFind",
  "view.hideFillers": "setHideFillers",
  "view.follow": "setFollow",
  "playback.toggle": "togglePlay",
  "playback.back": "jog",
  "playback.fwd": "jog",
  "language.retranscribe": "openRetranscribe",
  "help.shortcuts": "openShortcuts",
};

function actionById(id: string): EditorAction {
  const action = EDITOR_ACTIONS.find((entry) => entry.id === id);
  if (action === undefined) throw new Error(`no action ${id}`);
  return action;
}

describe("EDITOR_ACTIONS", () => {
  it("has unique ids", () => {
    const ids = EDITOR_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts every action in a menu the menubar renders", () => {
    const menus = new Set(EDITOR_MENUS.map((menu) => menu.id));
    for (const action of EDITOR_ACTIONS) {
      expect(menus.has(action.menu), `${action.id} → ${action.menu}`).toBe(true);
    }
  });

  it("includes the Share entry the editor mounts the links panel for", () => {
    const share = actionById("file.share");
    expect(share.menu).toBe("file");
    expect(share.label).toBe("Share…");
  });

  it("every action's run() calls exactly its own context function, once", () => {
    for (const action of EDITOR_ACTIONS) {
      const { ctx, spies } = spyContext({ canSplit: true, canWordEdit: true });
      const expected = EXPECTED_EFFECT[action.id];
      expect(expected, `${action.id} is not in EXPECTED_EFFECT`).toBeDefined();

      action.run(ctx);

      for (const [name, spy] of Object.entries(spies)) {
        if (name === expected) {
          expect(spy, `${action.id} → ${name}`).toHaveBeenCalledTimes(1);
        } else {
          expect(spy, `${action.id} must not call ${name}`).not.toHaveBeenCalled();
        }
      }
    }
  });

  it("gates the segment actions on a selected segment", () => {
    const none = spyContext({ canSplit: false }).ctx;
    const selected = spyContext({ canSplit: true }).ctx;
    for (const id of ["edit.split", "edit.merge"]) {
      expect(actionById(id).enabled(none), `${id} without a selection`).toBe(false);
      expect(actionById(id).enabled(selected), `${id} with a selection`).toBe(true);
    }
  });

  it("gates the word actions on a selected word", () => {
    const none = spyContext({ canWordEdit: false }).ctx;
    const selected = spyContext({ canWordEdit: true }).ctx;
    for (const id of ["edit.emphasize", "edit.deleteWord"]) {
      expect(actionById(id).enabled(none), `${id} without a word`).toBe(false);
      expect(actionById(id).enabled(selected), `${id} with a word`).toBe(true);
    }
  });

  it("leaves every other action always enabled", () => {
    const gated = new Set(["edit.split", "edit.merge", "edit.emphasize", "edit.deleteWord"]);
    const ctx = spyContext().ctx;
    for (const action of EDITOR_ACTIONS) {
      if (gated.has(action.id)) continue;
      expect(action.enabled(ctx), action.id).toBe(true);
    }
  });

  it("reports the checkbox actions' live state, and toggles it away from that state", () => {
    const off = spyContext({ hideFillers: false, follow: false });
    expect(actionById("view.hideFillers").checked?.(off.ctx)).toBe(false);
    expect(actionById("view.follow").checked?.(off.ctx)).toBe(false);
    actionById("view.hideFillers").run(off.ctx);
    actionById("view.follow").run(off.ctx);
    expect(off.spies.setHideFillers).toHaveBeenCalledWith(true);
    expect(off.spies.setFollow).toHaveBeenCalledWith(true);

    const on = spyContext({ hideFillers: true, follow: true });
    expect(actionById("view.hideFillers").checked?.(on.ctx)).toBe(true);
    expect(actionById("view.follow").checked?.(on.ctx)).toBe(true);
    actionById("view.hideFillers").run(on.ctx);
    actionById("view.follow").run(on.ctx);
    expect(on.spies.setHideFillers).toHaveBeenCalledWith(false);
    expect(on.spies.setFollow).toHaveBeenCalledWith(false);
  });

  it("jogs a second each way, in the direction the label promises", () => {
    const { ctx, spies } = spyContext();
    actionById("playback.back").run(ctx);
    expect(spies.jog).toHaveBeenCalledWith(-1000);
    spies.jog.mockClear();
    actionById("playback.fwd").run(ctx);
    expect(spies.jog).toHaveBeenCalledWith(1000);
  });

  it("marks exactly the delete as destructive", () => {
    const destructive = EDITOR_ACTIONS.filter((action) => action.destructive === true).map(
      (action) => action.id,
    );
    expect(destructive).toEqual(["edit.deleteWord"]);
  });

  /**
   * The shortcut strings are display-only, but a label that promises a key the
   * map does not bind is a lie the user finds the hard way. These are the
   * bindings `lib/edg/keyboard-shortcuts.ts`'s `classify()` actually has.
   */
  it("advertises the shortcuts the keyboard map really binds", () => {
    const shown = Object.fromEntries(
      EDITOR_ACTIONS.filter((a) => a.shortcut !== undefined).map((a) => [a.id, a.shortcut]),
    );
    expect(shown).toMatchObject({
      "edit.undo": "Ctrl+Z",
      "edit.redo": "Ctrl+Y",
      "edit.split": "S",
      "edit.merge": "M",
      "edit.emphasize": "E",
      "edit.deleteWord": "Del",
      "edit.find": "Ctrl+F",
      "playback.toggle": "Space",
      "playback.back": "J",
      "playback.fwd": "L",
    });
  });
});
