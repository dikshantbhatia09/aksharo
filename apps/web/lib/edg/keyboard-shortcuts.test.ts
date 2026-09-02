import { describe, expect, it } from "vitest";

import { classify, isTextEntryTarget, type KeyLike } from "./keyboard-shortcuts";

function key(overrides: Partial<KeyLike> & { key: string }): KeyLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("classify", () => {
  it("maps the transcript-editing keys", () => {
    expect(classify(key({ key: "s" }))).toBe("split");
    expect(classify(key({ key: "S" }))).toBe("split");
    expect(classify(key({ key: "m" }))).toBe("merge");
    expect(classify(key({ key: "e" }))).toBe("emphasize");
    expect(classify(key({ key: "Delete" }))).toBe("deleteWord");
    expect(classify(key({ key: "Backspace" }))).toBe("deleteWord");
  });

  it("maps the playback keys", () => {
    expect(classify(key({ key: " " }))).toBe("playPause");
    expect(classify(key({ key: "j" }))).toBe("jogBack");
    expect(classify(key({ key: "k" }))).toBe("jogPause");
    expect(classify(key({ key: "l" }))).toBe("jogForward");
  });

  it("Ctrl/Cmd+F opens find, regardless of platform modifier", () => {
    expect(classify(key({ key: "f", ctrlKey: true }))).toBe("find");
    expect(classify(key({ key: "f", metaKey: true }))).toBe("find");
    expect(classify(key({ key: "F", ctrlKey: true }))).toBe("find");
  });

  it("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
    expect(classify(key({ key: "z", ctrlKey: true }))).toBe("undo");
    expect(classify(key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(classify(key({ key: "y", ctrlKey: true }))).toBe("redo");
  });

  it("A and R are reserved (B20's Passes review) and are not bound here", () => {
    expect(classify(key({ key: "a" }))).toBeUndefined();
    expect(classify(key({ key: "r" }))).toBeUndefined();
  });

  it("an unmodified letter that is not in the map is ignored", () => {
    expect(classify(key({ key: "q" }))).toBeUndefined();
  });

  it("any other Ctrl/Alt combination is left for the browser/OS", () => {
    expect(classify(key({ key: "c", ctrlKey: true }))).toBeUndefined();
    expect(classify(key({ key: "s", altKey: true }))).toBeUndefined();
  });
});

describe("isTextEntryTarget", () => {
  it("is true for contenteditable, input, textarea and select", () => {
    const editable = document.createElement("div");
    // `.contentEditable = "true"` should reflect to the attribute per spec,
    // but jsdom's reflection is incomplete here — set the attribute directly,
    // which is what `WordChip`'s rendered DOM actually carries either way.
    editable.setAttribute("contenteditable", "true");
    expect(isTextEntryTarget(editable)).toBe(true);
    expect(isTextEntryTarget(document.createElement("input"))).toBe(true);
    expect(isTextEntryTarget(document.createElement("textarea"))).toBe(true);
    expect(isTextEntryTarget(document.createElement("select"))).toBe(true);
  });

  it("is false for a plain element or null", () => {
    expect(isTextEntryTarget(document.createElement("div"))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
