import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const adminFetchMock = vi.fn();
vi.mock("@/lib/admin/use-admin-fetch", () => ({
  useAdminFetch: () => adminFetchMock,
}));

import AdminPartnerCatalogueGrantsPage from "./page";

const ROW = {
  id: "g1",
  workspaceId: "01JWORKSPACE00000000000000",
  providerAssetId: "mock-sfx-0001",
  useContext: "pass_item",
  status: "active",
  expiresAt: null,
  createdAt: "2026-09-03T00:00:00.000Z",
  reportStatus: "unreported" as const,
};

describe("AdminPartnerCatalogueGrantsPage (D04b2 scope §5)", () => {
  it("lists a grant fetched from /admin/partner-catalogue/grants", async () => {
    adminFetchMock.mockResolvedValueOnce([ROW]);
    render(<AdminPartnerCatalogueGrantsPage />);

    expect(await screen.findByText("mock-sfx-0001")).toBeInTheDocument();
    expect(screen.getByText("01JWORKSPACE00000000000000")).toBeInTheDocument();
    expect(screen.getByText("pass_item")).toBeInTheDocument();
    expect(screen.getByText("unreported")).toBeInTheDocument();
    expect(adminFetchMock).toHaveBeenCalledWith("/admin/partner-catalogue/grants");
  });

  it("shows a placeholder row when there are no grants", async () => {
    adminFetchMock.mockResolvedValueOnce([]);
    render(<AdminPartnerCatalogueGrantsPage />);
    expect(await screen.findByText("No grants.")).toBeInTheDocument();
  });

  it("revokes an active grant and refetches the list", async () => {
    adminFetchMock.mockResolvedValueOnce([ROW]);
    render(<AdminPartnerCatalogueGrantsPage />);
    const revokeButton = await screen.findByRole("button", { name: "Revoke" });

    adminFetchMock.mockResolvedValueOnce({ revoked: true });
    adminFetchMock.mockResolvedValueOnce([{ ...ROW, status: "revoked" }]);
    await act(async () => {
      revokeButton.click();
    });
    // Revoking asks first (ConfirmAction); confirm it.
    await act(async () => {
      (await screen.findByRole("button", { name: "Revoke grant" })).click();
    });

    await waitFor(() => {
      expect(adminFetchMock).toHaveBeenCalledWith("/admin/partner-catalogue/grants/g1/revoke", {
        method: "POST",
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    });
  });

  it("shows an error message when the fetch fails", async () => {
    adminFetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<AdminPartnerCatalogueGrantsPage />);
    expect(await screen.findByText("network down")).toBeInTheDocument();
  });
});
