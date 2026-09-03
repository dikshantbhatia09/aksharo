import { describe, expect, it } from "vitest";

import {
  applyClassificationRules,
  findCanonicalRulesPath,
  readCanonicalRules,
  SHARED_CLASSIFICATION_RULES,
} from "./classification-rules.js";

describe("SHARED_CLASSIFICATION_RULES", () => {
  it("matches C08b's classification_rules.json when it exists in this worktree", () => {
    const canonicalPath = findCanonicalRulesPath();
    if (!canonicalPath) {
      // C08b's file lives at plugins/resolve/aksharo_core_app/fusion/classification_rules.json.
      // Not a failure here — just nothing to compare against yet in a worktree without it.
      expect(canonicalPath).toBeUndefined();
      return;
    }
    const canonical = readCanonicalRules(canonicalPath);
    // Compare rule bodies (ids, fields, predicates, status), not the exact reason prose — this
    // module intentionally rewords reasons for AE text layers instead of reusing Text+ wording.
    const canonicalShape = canonical.rules.map(({ id, field, equals, lt, when, status }) => ({
      id,
      field,
      equals,
      lt,
      when,
      status,
    }));
    const mirroredShape = SHARED_CLASSIFICATION_RULES.rules.map(
      ({ id, field, equals, lt, when, status }) => ({
        id,
        field,
        equals,
        lt,
        when,
        status,
      }),
    );
    expect(mirroredShape).toEqual(canonicalShape);
  });

  it("applyClassificationRules picks the worst status across every firing rule", () => {
    const karaoke = {
      animation: { wordHighlight: { type: "karaoke-fill" }, perWord: false },
      box: { enabled: false },
    };
    expect(applyClassificationRules(karaoke).status).toBe("unsupported");

    const perWordOnly = {
      animation: { wordHighlight: { type: "none" }, perWord: true },
      box: { enabled: false },
    };
    expect(applyClassificationRules(perWordOnly).status).toBe("approximate");

    const plain = {
      animation: { wordHighlight: { type: "color" }, perWord: false },
      box: { enabled: false },
    };
    expect(applyClassificationRules(plain).status).toBe("supported");
  });

  it("the box-word-mode and box-translucent-glass rules only fire when box.enabled is true", () => {
    const disabledBox = {
      animation: { wordHighlight: { type: "none" }, perWord: false },
      box: { enabled: false, mode: "word", opacity: 0.1 },
    };
    expect(applyClassificationRules(disabledBox).status).toBe("supported");

    const enabledWordBox = {
      animation: { wordHighlight: { type: "none" }, perWord: false },
      box: { enabled: true, mode: "word", opacity: 1 },
    };
    expect(applyClassificationRules(enabledWordBox).status).toBe("unsupported");

    const enabledGlassBox = {
      animation: { wordHighlight: { type: "none" }, perWord: false },
      box: { enabled: true, mode: "block", opacity: 0.2 },
    };
    expect(applyClassificationRules(enabledGlassBox).status).toBe("unsupported");

    const enabledOpaqueBox = {
      animation: { wordHighlight: { type: "none" }, perWord: false },
      box: { enabled: true, mode: "block", opacity: 0.9 },
    };
    expect(applyClassificationRules(enabledOpaqueBox).status).toBe("supported");
  });
});
