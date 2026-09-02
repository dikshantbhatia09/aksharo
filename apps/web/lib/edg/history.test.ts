import { describe, expect, it } from "vitest";

import { EditHistory } from "./history";
import { editWord } from "./ops";

let counter = 0;
function id(): string {
  counter += 1;
  return `op-${String(counter)}`;
}

describe("EditHistory", () => {
  it("undo pops the last action and moves it to redo", () => {
    const history = new EditHistory();
    const ops = [editWord("0:0", "b", undefined, id)];
    const inverseOps = [editWord("0:0", "a", undefined, id)];
    history.record({ actionId: "a1", ops, inverseOps });

    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    const undone = history.undo();
    expect(undone?.inverseOps).toBe(inverseOps);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);

    const redone = history.redo();
    expect(redone?.ops).toBe(ops);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
  });

  it("a new action clears the redo stack", () => {
    const history = new EditHistory();
    history.record({ actionId: "a1", ops: [editWord("0:0", "b", undefined, id)], inverseOps: [] });
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.record({ actionId: "a2", ops: [editWord("0:1", "c", undefined, id)], inverseOps: [] });
    expect(history.canRedo()).toBe(false);
  });

  it("undo/redo on an empty stack is a no-op", () => {
    const history = new EditHistory();
    expect(history.undo()).toBeUndefined();
    expect(history.redo()).toBeUndefined();
  });

  it("ignores an action with no ops", () => {
    const history = new EditHistory();
    history.record({ actionId: "a1", ops: [], inverseOps: [] });
    expect(history.canUndo()).toBe(false);
  });

  it("caps the undo stack at its limit, dropping the oldest", () => {
    const history = new EditHistory(3);
    for (let i = 0; i < 5; i += 1) {
      history.record({
        actionId: `a${String(i)}`,
        ops: [editWord("0:0", String(i), undefined, id)],
        inverseOps: [],
      });
    }
    expect(history.size()).toEqual({ undo: 3, redo: 0 });
    expect(history.peekUndo()?.actionId).toBe("a4");
  });

  it("clear empties both stacks", () => {
    const history = new EditHistory();
    history.record({ actionId: "a1", ops: [editWord("0:0", "b", undefined, id)], inverseOps: [] });
    history.undo();
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
