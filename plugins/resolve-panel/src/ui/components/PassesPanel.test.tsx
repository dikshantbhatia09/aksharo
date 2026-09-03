import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PassesPanel } from "./PassesPanel.js";

describe("PassesPanel", () => {
  it("shows the empty state when there are no passes", () => {
    render(
      <PassesPanel passes={undefined} applying={false} applyError={undefined} onApply={() => {}} />,
    );
    expect(screen.getByTestId("passes-empty")).toBeInTheDocument();
    expect(screen.getByTestId("apply-button")).toBeDisabled();
  });

  it("lists items and enables Apply when at least one is accepted", async () => {
    const onApply = vi.fn();
    render(
      <PassesPanel
        passes={{
          passes: [
            {
              passId: "pass_1",
              type: "autocut",
              items: [
                { itemId: "a", kind: "cut", state: "accepted" },
                { itemId: "b", kind: "cut", state: "proposed" },
              ],
            },
          ],
        }}
        applying={false}
        applyError={undefined}
        onApply={onApply}
      />,
    );
    expect(screen.getByTestId("pass-item-a")).toBeInTheDocument();
    expect(screen.getByTestId("pass-item-b")).toBeInTheDocument();
    expect(screen.getByTestId("apply-button")).toBeEnabled();
    await userEvent.click(screen.getByTestId("apply-button"));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("shows the apply error", () => {
    render(
      <PassesPanel
        passes={{ passes: [] }}
        applying={false}
        applyError="transaction failed"
        onApply={() => {}}
      />,
    );
    expect(screen.getByTestId("apply-error").textContent).toMatch(/transaction failed/);
  });
});
