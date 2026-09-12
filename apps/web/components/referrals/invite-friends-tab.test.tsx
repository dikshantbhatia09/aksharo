import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InviteFriendsTab } from "./invite-friends-tab";

import { renderWithProviders } from "@/test/harness";

vi.stubGlobal("navigator", {
  ...navigator,
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

const STATS = {
  code: "AK-4H7K2M",
  pending: 2,
  granted: 1,
  rejected: 0,
  bonusGrantedAt: null,
  promptShownAt: null,
  promptEligible: false,
};

describe("<InviteFriendsTab />", () => {
  it("renders the code, share row and reward counts", async () => {
    renderWithProviders(<InviteFriendsTab />, {
      routes: { "/referrals/me": STATS },
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("AK-4H7K2M")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("https://kalakar.io/signup?ref=AK-4H7K2M")).toBeInTheDocument();
    expect(screen.getByTestId("referral-stat-pending")).toHaveTextContent("2");
    expect(screen.getByTestId("referral-stat-granted")).toHaveTextContent("1");
    expect(screen.queryByTestId("referral-bonus-earned")).toBeNull();
  });

  it("shows the bonus message once earned", async () => {
    renderWithProviders(<InviteFriendsTab />, {
      routes: {
        "/referrals/me": { ...STATS, granted: 3, bonusGrantedAt: "2026-09-02T00:00:00.000Z" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("referral-bonus-earned")).toBeInTheDocument();
    });
  });
});
