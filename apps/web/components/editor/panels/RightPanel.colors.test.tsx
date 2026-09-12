import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { resolveColour, type Gradient, type StyleDoc } from "@montaj/caption-styles";

import { ColorsPanel } from "./RightPanel";
import { SYSTEM_STYLE_MAP } from "./system-styles";

/**
 * K08 acceptance criterion 4: "the panel's Gradient mode is a real, wired
 * control — stops and angle changes visibly update the live canvas preview."
 * `ColorOrGradientField.test.tsx` covers the control's own behaviour in
 * isolation; this file covers the two K08 call sites that wire it into
 * `ColorsPanel` — the Text field (`colors.text`, a dotted `setStyleField`
 * path) and the Emphasis colour field (`emphasisPresets[0].color`, the
 * array-rebuilding `withDefaultEmphasisField` shape) — confirming each
 * reaches `onOp` with an op the live style (and so the canvas, which rerenders
 * on every `style` prop change — `StylePreviewCanvas`'s own `useEffect`
 * dependency array) would actually pick up.
 */

const PUNCH_POP = SYSTEM_STYLE_MAP.get("punch-pop");
if (PUNCH_POP === undefined) throw new Error("fixture style punch-pop is missing");

const DOC = { kind: "doc" } as const;

function renderColorsPanel(style: StyleDoc, onOp = vi.fn()): { onOp: typeof onOp } {
  render(<ColorsPanel style={style} scope={DOC} onOp={onOp} />);
  // Emphasis now starts collapsed (design/09's own screenshot opens on
  // Color, not Emphasis) — expand it so this file's Emphasis-field
  // assertions still see their controls.
  fireEvent.click(screen.getByRole("button", { name: "Emphasis" }));
  return { onOp };
}

describe("ColorsPanel Text field (K08)", () => {
  it("starts Solid for a system style, whose colors.text is a plain hex string", () => {
    renderColorsPanel(PUNCH_POP);
    expect(screen.getByTestId("field-colors-text-mode-solid")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("field-colors-text-solid")).toHaveValue(
      resolveColour(PUNCH_POP.colors.text).slice(0, 7),
    );
  });

  it("switching to Gradient emits a SetStyle op whose colors.text is a Gradient object", async () => {
    const { onOp } = renderColorsPanel(PUNCH_POP);
    await userEvent.click(screen.getByTestId("field-colors-text-mode-gradient"));
    expect(onOp).toHaveBeenCalledTimes(1);
    const op = onOp.mock.calls[0]?.[0] as { overrides?: { colors?: { text?: Gradient } } };
    expect(op.overrides?.colors?.text).toMatchObject({ angleDeg: 90 });
    expect(op.overrides?.colors?.text?.stops).toHaveLength(2);
  });

  it("moving the angle slider once already in Gradient mode emits only the angle", async () => {
    const gradientStyle: StyleDoc = {
      ...PUNCH_POP,
      colors: {
        ...PUNCH_POP.colors,
        text: {
          stops: [
            { offset: 0, color: "#ff0000ff" },
            { offset: 1, color: "#0000ffff" },
          ],
          angleDeg: 0,
        },
      },
    };
    const { onOp } = renderColorsPanel(gradientStyle);
    fireEvent.change(screen.getByTestId("field-colors-text-angle"), { target: { value: "270" } });
    expect(onOp).toHaveBeenCalledTimes(1);
    const op = onOp.mock.calls[0]?.[0] as { overrides?: { colors?: { text?: Gradient } } };
    expect(op.overrides?.colors?.text?.angleDeg).toBe(270);
    // The dotted path only touches colors.text — the merge layer
    // (`apps/web/lib/edg/ops.ts`'s mergeStyleOverrides) is what keeps the
    // stops that already exist; this op's own overrides carry the whole new
    // colors.text object `setStyleField`'s `expandPath` always builds.
    expect(op.overrides?.colors?.text?.stops).toHaveLength(2);
  });
});

describe("Emphasis colour field (K08)", () => {
  const defaultPreset = PUNCH_POP.emphasisPresets[0];
  if (defaultPreset === undefined) throw new Error("fixture style has no default emphasis preset");

  it("falls back to the base text colour, resolved to solid, when the preset has no colour override", () => {
    const noColour: StyleDoc = {
      ...PUNCH_POP,
      emphasisPresets: [{ ...defaultPreset, color: undefined }],
    };
    renderColorsPanel(noColour);
    expect(screen.getByTestId("field-emphasis-color-solid")).toHaveValue(
      resolveColour(PUNCH_POP.colors.text).slice(0, 7),
    );
  });

  it("switching the emphasis colour to Gradient rebuilds emphasisPresets[0] only", async () => {
    const { onOp } = renderColorsPanel(PUNCH_POP);
    await userEvent.click(screen.getByTestId("field-emphasis-color-mode-gradient"));
    expect(onOp).toHaveBeenCalledTimes(1);
    const op = onOp.mock.calls[0]?.[0] as {
      overrides?: { emphasisPresets?: Array<{ id?: string; color?: Gradient }> };
    };
    const rebuilt = op.overrides?.emphasisPresets?.[0];
    expect(rebuilt?.id).toBe(PUNCH_POP.emphasisPresets[0]?.id);
    expect(rebuilt?.color).toMatchObject({ angleDeg: 90 });
  });
});
