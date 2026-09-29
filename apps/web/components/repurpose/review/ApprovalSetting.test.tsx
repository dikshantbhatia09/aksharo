import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ApprovalSetting } from "./ApprovalSetting";

import { renderWithProviders, testAccessToken } from "@/test/harness";

const WORKSPACE = "/workspaces/01JWORKSPACE";

function patches(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(String(input)).pathname === WORKSPACE &&
        (init as RequestInit | undefined)?.method === "PATCH",
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as unknown);
}

describe("<ApprovalSetting />", () => {
  it("lets an owner turn approval on, through the workspace's settings", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<ApprovalSetting />, {
      routes: { [WORKSPACE]: { id: "01JWORKSPACE", role: "owner", settings: {} } },
    });
    const toggle = await screen.findByRole("switch", {
      name: /Clips need approval before posting/,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await waitFor(() => {
      expect(patches(fetchMock)).toEqual([{ settings: { clipsNeedApproval: true } }]);
    });
  });

  it("shows an editor the setting, read only, and who can change it", async () => {
    renderWithProviders(<ApprovalSetting />, {
      accessToken: testAccessToken({ role: "editor" }),
      routes: {
        [WORKSPACE]: { id: "01JWORKSPACE", role: "editor", settings: { clipsNeedApproval: true } },
      },
    });
    const toggle = await screen.findByRole("switch", {
      name: /Clips need approval before posting/,
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("approval-setting-read-only")).toHaveTextContent(
      "Only an owner or admin can change this.",
    );
  });
});
