import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReferralPromptSheet } from "./referral-prompt-sheet";

import { renderWithProviders } from "@/test/harness";

vi.stubGlobal("navigator", {
  ...navigator,
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

const ELIGIBLE_STATS = {
  code: "AK-4H7K2M",
  pending: 0,
  granted: 0,
  rejected: 0,
  bonusGrantedAt: null,
  promptShownAt: null,
  promptEligible: true,
};

describe("<ReferralPromptSheet />", () => {
  it("opens and marks itself shown when the server reports promptEligible", async () => {
    const { fetchMock } = renderWithProviders(<ReferralPromptSheet />, {
      routes: {
        "/referrals/me": ELIGIBLE_STATS,
        "/referrals/prompt/shown": { shownAt: "2026-09-02T00:00:00.000Z" },
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("referral-prompt-sheet")).toBeInTheDocument();
    });
    expect(screen.getByText("Give 30 credits, get 30 credits")).toBeInTheDocument();
    expect(screen.getByDisplayValue("AK-4H7K2M")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/referrals/prompt/shown")),
      ).toBe(true);
    });
  });

  it("renders nothing when the workspace is not prompt-eligible", async () => {
    renderWithProviders(<ReferralPromptSheet />, {
      routes: { "/referrals/me": { ...ELIGIBLE_STATS, promptEligible: false } },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("referral-prompt-sheet")).toBeNull();
    });
  });

  it("renders nothing once the sheet has already been shown", async () => {
    renderWithProviders(<ReferralPromptSheet />, {
      routes: {
        "/referrals/me": {
          ...ELIGIBLE_STATS,
          promptEligible: false,
          promptShownAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });

    await waitFor(() => {
      expect(screen.queryByTestId("referral-prompt-sheet")).toBeNull();
    });
  });
});
