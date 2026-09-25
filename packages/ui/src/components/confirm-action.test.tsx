import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmAction } from "./confirm-action";
import { Button } from "../primitives/button";


function setup() {
  const onConfirm = vi.fn();
  render(
    <ConfirmAction
      trigger={<Button data-testid="revoke-key">Revoke</Button>}
      title="Revoke this key?"
      description="Anything using it stops working straight away."
      confirmLabel="Revoke key"
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, user: userEvent.setup() };
}

describe("<ConfirmAction />", () => {
  it("does not act on the first click; it asks", async () => {
    const { onConfirm, user } = setup();
    await user.click(screen.getByTestId("revoke-key"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Revoke this key?" })).toBeVisible();
  });

  it("focuses Cancel first, so Enter never destroys anything", async () => {
    const { onConfirm, user } = setup();
    await user.click(screen.getByTestId("revoke-key"));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("acts once confirmed, with a button named for the action", async () => {
    const { onConfirm, user } = setup();
    await user.click(screen.getByTestId("revoke-key"));
    await user.click(screen.getByRole("button", { name: "Revoke key" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
