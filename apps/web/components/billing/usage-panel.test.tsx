import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { usageToCsv, UsagePanel } from "./usage-panel";

import type { CreditsSummary, UsageEntry, UsagePage } from "@/lib/billing/types";

import { renderWithProviders } from "@/test/harness";

describe("usageToCsv", () => {
  const entries: UsageEntry[] = [
    {
      id: "led_1",
      deltaTenths: -100,
      kind: "hold",
      refType: "job",
      refId: "job_1",
      lotId: "lot_1",
      balanceAfterTenths: 4_900,
      at: "2027-01-05T10:00:00.000Z",
      jobType: "transcribe",
    },
    {
      id: "led_2",
      deltaTenths: 5_000,
      kind: "grant",
      refType: "subscription",
      refId: null,
      lotId: "lot_2",
      balanceAfterTenths: 9_900,
      at: "2027-01-01T00:00:00.000Z",
      jobType: null,
    },
  ];

  it("has a header row and one row per entry, credits (not tenths)", () => {
    const csv = usageToCsv(entries);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("date,kind,delta_credits,balance_after_credits,ref_type,ref_id,job_type");
    expect(lines[1]).toBe("2027-01-05T10:00:00.000Z,hold,-10,490,job,job_1,transcribe");
    expect(lines[2]).toBe("2027-01-01T00:00:00.000Z,grant,500,990,subscription,,");
  });

  it("produces just the header for no entries", () => {
    expect(usageToCsv([])).toBe(
      "date,kind,delta_credits,balance_after_credits,ref_type,ref_id,job_type",
    );
  });
});

const USAGE_PAGE: UsagePage = {
  items: [
    {
      id: "led_1",
      deltaTenths: -100,
      kind: "hold",
      refType: "job",
      refId: "job_1",
      lotId: null,
      balanceAfterTenths: 4_900,
      at: "2027-01-05T10:00:00.000Z",
      jobType: "transcribe",
    },
  ],
  nextCursor: null,
};

const CREDITS: CreditsSummary = {
  workspaceId: "01JWORKSPACE",
  balanceTenths: 4_900,
  monthlyGrantTenths: 5_000,
  grantResetAt: "2027-02-01T00:00:00.000Z",
  lots: [
    {
      id: "lot_1",
      source: "grant",
      grantedTenths: 5_000,
      remainingTenths: 4_900,
      expiresAt: "2027-02-01T00:00:00.000Z",
      createdAt: "2027-01-01T00:00:00.000Z",
    },
  ],
};

describe("<UsagePanel />", () => {
  it("renders the ledger history with per-job attribution", async () => {
    renderWithProviders(<UsagePanel />, {
      routes: {
        "/workspaces/01JWORKSPACE/usage": USAGE_PAGE,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
      },
    });
    const row = await screen.findByTestId("usage-row");
    expect(row).toHaveTextContent("transcribe");
    expect(row).toHaveTextContent("-10");
  });

  it("lists lots with their expiry", async () => {
    renderWithProviders(<UsagePanel />, {
      routes: {
        "/workspaces/01JWORKSPACE/usage": USAGE_PAGE,
        "/workspaces/01JWORKSPACE/credits": CREDITS,
      },
    });
    const lots = await screen.findByTestId("usage-lots");
    expect(lots).toHaveTextContent("490 of 500 left");
  });

  it("shows an empty state with nothing to export when there is no history", async () => {
    renderWithProviders(<UsagePanel />, {
      routes: {
        "/workspaces/01JWORKSPACE/usage": { items: [], nextCursor: null } satisfies UsagePage,
        "/workspaces/01JWORKSPACE/credits": { ...CREDITS, lots: [] } satisfies CreditsSummary,
      },
    });
    expect(await screen.findByTestId("usage-empty")).toBeInTheDocument();
    expect(screen.getByTestId("export-usage-csv")).toBeDisabled();
  });
});
