import { describe, expect, it } from "vitest";

import {
  expandPath,
  setEmphasis,
  setSegmentPosition,
  setStyleField,
  setStyleFields,
  setStyleRef,
  stylePresetDraft,
} from "./ops";

const DOC = { kind: "doc" } as const;
const SEGMENT = { kind: "segment", segmentId: "01KF0FV2E0B35H77H53BXSZF9D" } as const;

let counter = 0;
const opId = (): string => `op-${String((counter += 1))}`;

describe("expandPath", () => {
  it("turns a dotted path into the nested partial SetStyle carries", () => {
    expect(expandPath("typography.sizePct", 7)).toEqual({ typography: { sizePct: 7 } });
    expect(expandPath("animation.in.durationMs", 200)).toEqual({
      animation: { in: { durationMs: 200 } },
    });
    expect(expandPath("colors", { text: "#fff" })).toEqual({ colors: { text: "#fff" } });
  });

  it("refuses an empty path rather than writing a nameless override", () => {
    expect(() => expandPath("", 1)).toThrow(/cannot be empty/);
    expect(() => expandPath("...", 1)).toThrow(/cannot be empty/);
  });
});

describe("setStyleRef", () => {
  it("writes the document scope when nothing is selected", () => {
    expect(setStyleRef(DOC, "punch-pop", opId)).toEqual({
      op: "SetStyle",
      opId: "op-1",
      scope: "doc",
      styleRef: "punch-pop",
    });
  });

  it("writes the segment scope with its id when a caption is selected", () => {
    expect(setStyleRef(SEGMENT, "karaoke-fill", opId)).toEqual({
      op: "SetStyle",
      opId: "op-2",
      scope: "segment",
      segmentId: SEGMENT.segmentId,
      styleRef: "karaoke-fill",
    });
  });
});

describe("setStyleField", () => {
  it("carries one nested override and no styleRef", () => {
    const op = setStyleField(DOC, "typography.sizePct", 5.5, opId);
    expect(op.overrides).toEqual({ typography: { sizePct: 5.5 } });
    expect(op.styleRef).toBeUndefined();
    expect(op.scope).toBe("doc");
  });

  it("keeps the segment id at segment scope", () => {
    expect(setStyleField(SEGMENT, "layout.y", 0.8, opId).segmentId).toBe(SEGMENT.segmentId);
  });

  it("carries a boolean and a string as faithfully as a number", () => {
    expect(setStyleField(DOC, "box.enabled", false, opId).overrides).toEqual({ box: { enabled: false } });
    expect(setStyleField(DOC, "layout.align", "left", opId).overrides).toEqual({ layout: { align: "left" } });
  });
});

describe("setStyleFields", () => {
  it("merges several paths into one op, which is what a brand kit needs", () => {
    const op = setStyleFields(
      DOC,
      {
        "colors.text": "#ffffff",
        "colors.accent": "#ff2e63",
        "stroke.enabled": true,
        "stroke.color": "#0b0b0f",
      },
      opId,
    );
    expect(op.overrides).toEqual({
      colors: { text: "#ffffff", accent: "#ff2e63" },
      stroke: { enabled: true, color: "#0b0b0f" },
    });
  });

  it("produces an empty override for an empty change set", () => {
    expect(setStyleFields(DOC, {}, opId).overrides).toEqual({});
  });

  it("lets a later path win over an earlier one at the same leaf", () => {
    const op = setStyleFields(DOC, { "colors.text": "#000000", colors: { text: "#ffffff" } }, opId);
    expect(op.overrides).toEqual({ colors: { text: "#ffffff" } });
  });
});

describe("setSegmentPosition", () => {
  it("carries the dropped position", () => {
    expect(setSegmentPosition("seg", { x: 0.5, y: 0.8, anchor: "bottom-center" }, opId)).toMatchObject({
      op: "SetSegmentPosition",
      segmentId: "seg",
      position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
    });
  });

  it("carries null to clear an override back to the style's own position", () => {
    expect(setSegmentPosition("seg", null, opId).position).toBeNull();
  });
});

describe("setEmphasis", () => {
  it("applies and clears a preset on one word", () => {
    expect(setEmphasis("seg", "0:17", "pop", opId)).toMatchObject({
      op: "SetEmphasis",
      segmentId: "seg",
      wordId: "0:17",
      presetId: "pop",
    });
    expect(setEmphasis("seg", "0:17", null, opId).presetId).toBeNull();
  });
});

describe("op ids", () => {
  it("gives every op its own id, and uses a real factory by default", () => {
    const first = setStyleRef(DOC, "punch-pop");
    const second = setStyleRef(DOC, "punch-pop");
    expect(first.opId).not.toBe(second.opId);
    expect(first.opId).toMatch(/^panel-\d+$/);
  });
});

describe("stylePresetDraft", () => {
  it("trims the name and keeps the base style and overrides", () => {
    expect(stylePresetDraft("  My look  ", "punch-pop", { typography: { sizePct: 7 } })).toEqual({
      name: "My look",
      baseStyleId: "punch-pop",
      overrides: { typography: { sizePct: 7 } },
    });
  });

  it("refuses a name too short to find again", () => {
    expect(() => stylePresetDraft(" a ", "punch-pop", {})).toThrow(/at least two characters/);
    expect(() => stylePresetDraft("   ", "punch-pop", {})).toThrow();
  });
});
