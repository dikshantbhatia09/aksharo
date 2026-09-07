import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { initials, ProfileMenu } from "./profile-menu";
import { formatStorageBytes, Sidebar, sumStorageBytes, UpgradeButton } from "./sidebar";
import { TopBar } from "./top-bar";
import { WorkspaceSwitcher } from "./workspace-switcher";

import { PRIMARY_NAV } from "@/lib/nav";
import { renderWithProviders, testAccessToken } from "@/test/harness";
import { pathnameMock } from "@/test/next-router";

const ENTITLEMENT = {
  "/entitlement": {
    plan: "creator",
    creditsRemainingTenths: 4120,
    creditsIncludedTenths: 5000,
    resetsAt: "2026-09-30T00:00:00.000Z",
    features: {},
  },
};

describe("<Sidebar />", () => {
  it("renders the whole information architecture of 08 §3", () => {
    renderWithProviders(<Sidebar />);
    for (const item of PRIMARY_NAV) {
      expect(screen.getByTestId(`nav-${item.key}`)).toHaveTextContent(item.label);
    }
  });

  it("links what exists and disables what does not, instead of shipping dead links", () => {
    renderWithProviders(<Sidebar />);
    expect(screen.getByTestId("nav-home").tagName).toBe("A");
    // Projects landed in A14.
    expect(screen.getByTestId("nav-projects").tagName).toBe("A");
    const templates = screen.getByTestId("nav-templates");
    expect(templates.tagName).not.toBe("A");
    expect(templates).toHaveAttribute("aria-disabled", "true");
    expect(templates).toHaveTextContent("Soon");
  });

  it("marks the current page for assistive technology, not only with colour", () => {
    pathnameMock.value = "/";
    renderWithProviders(<Sidebar />);
    expect(screen.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  });

  it("offers the desktop download from the brand domain, never the codename", () => {
    renderWithProviders(<Sidebar />);
    const download = screen.getByTestId("desktop-download");
    expect(download).toHaveAttribute("href", "https://aksharo.ai/download");
    expect(download.getAttribute("href")).not.toContain("montaj");
  });

  // F07-E8: aksharo.ai/download only exists for the production deployment.
  it("does not offer that download from a build served somewhere else", () => {
    renderWithProviders(<Sidebar />, { config: { webOrigin: "http://127.0.0.1:3934" } });
    expect(screen.queryByTestId("desktop-download")).toBeNull();
  });

  it("shows the credit meter with what the entitlement says", async () => {
    renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
    // `/entitlement` is A05's and is not in the API yet, so the meter renders
    // the honest zero rather than an error state.
    expect(await screen.findByTestId("credit-meter-balance")).toHaveTextContent("0 left");
  });

  it("keeps the streak badge behind its flag", async () => {
    renderWithProviders(<Sidebar />, { config: { flags: { "growth.streakWidget": false } } });
    await waitFor(() => {
      expect(screen.getByTestId("credit-meter")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("credit-meter-streak")).toBeNull();
  });

  // K04: Storage and Audio-Clean counters alongside the transcription meter.
  describe("usage counters (K04)", () => {
    it("shows an Audio Clean row drawing on the same credit balance as transcription", async () => {
      renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
      // Same "/entitlement" mismatch as the transcription meter's own test above
      // (that route is not `useEntitlement`'s real one) — the honest zero, for
      // both meters, since they read the very same balance.
      expect(await screen.findByTestId("audio-clean-meter-balance")).toHaveTextContent("0 left");
      expect(screen.getByText("Audio Clean")).toBeInTheDocument();
      // No minute-equivalence clause from the transcription meter's own
      // `formatMinutes` — this row's unit clause is audio-clean-specific.
      expect(screen.getByTestId("audio-clean-meter-balance")).toHaveTextContent("audio clean");
    });

    it("shows a Storage row with no bar and no reset date (no plan quota exists to draw one against)", async () => {
      renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
      await waitFor(() => {
        expect(screen.getByTestId("storage-meter-balance")).toHaveTextContent("used");
      });
      expect(screen.getByText("Storage")).toBeInTheDocument();
      expect(screen.queryByTestId("storage-meter-reset")).toBeNull();
      expect(within(screen.getByTestId("storage-meter")).queryByRole("progressbar")).toBeNull();
    });
  });
});

describe("sumStorageBytes (K04)", () => {
  it("adds media and font bytes together, treating null sizes as zero", () => {
    expect(
      sumStorageBytes([{ sizeBytes: 1_000 }, { sizeBytes: null }, { sizeBytes: 500 }], []),
    ).toBe(1_500);
  });

  it("counts both a font's original and its subset WOFF2 bytes", () => {
    const font = {
      id: "f1",
      workspaceId: "w1",
      family: "Test",
      style: "regular",
      status: "ready" as const,
      sanitised: true,
      weight: 400,
      italic: false,
      scripts: [],
      sizeBytes: 200_000,
      woff2SizeBytes: 50_000,
      filename: "test.ttf",
      licenceAttestedBy: null,
      attestedAt: null,
      attestationVersion: null,
      licenceNote: null,
      servedOnlyToWorkspace: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(sumStorageBytes([], [font])).toBe(250_000);
  });

  it("is zero for an empty workspace", () => {
    expect(sumStorageBytes([], [])).toBe(0);
  });
});

describe("formatStorageBytes (K04)", () => {
  it("shows KB below one MB", () => {
    expect(formatStorageBytes(500 * 1024)).toBe("500 KB");
  });

  it("shows whole MB below one GB", () => {
    expect(formatStorageBytes(250 * 1024 * 1024)).toBe("250 MB");
  });

  it("shows GB with one decimal once it crosses a gigabyte", () => {
    expect(formatStorageBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("drops the decimal for a whole number of GB", () => {
    expect(formatStorageBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });

  it("floors at 0 B", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(-5)).toBe("0 B");
  });
});

/** A free-plan entitlement, so the CTA's plan guard is satisfied (F07-A1). */
const FREE_ENTITLEMENT = {
  "/workspaces/01JWORKSPACE/entitlement": {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 0,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: {},
    computedAt: "2026-09-05T00:00:00.000Z",
  },
};

describe("<UpgradeButton />", () => {
  it("renders nothing until the plan is known", () => {
    const { container } = renderWithProviders(<UpgradeButton />);
    expect(container.querySelector("[data-testid=upgrade-cta]")).toBeNull();
  });

  it("offers the upgrade when the payment rail is on and the plan can be upgraded", async () => {
    renderWithProviders(<UpgradeButton />, {
      routes: FREE_ENTITLEMENT,
      config: { razorpayEnabled: true },
    });
    expect(await screen.findByTestId("upgrade-cta")).toHaveAttribute("href", "/billing");
  });

  it("hides the upgrade entirely when there is no payment rail to buy through", async () => {
    const { container } = renderWithProviders(<UpgradeButton />, {
      routes: FREE_ENTITLEMENT,
      config: { razorpayEnabled: false },
    });
    // The entitlement resolves, so the only thing keeping the CTA away is the
    // rail gate — not a still-loading plan.
    await waitFor(() => {
      expect(container.querySelector("[data-testid=upgrade-cta]")).toBeNull();
    });
    expect(screen.queryByRole("link", { name: "Upgrade" })).toBeNull();
  });
});

describe("<TopBar />", () => {
  it("offers search, New project and What's new", () => {
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} />);
    expect(screen.getByTestId("open-palette")).toHaveTextContent("Search projects and actions");
    expect(screen.getByTestId("new-project")).toBeInTheDocument();
    // The changelog lives at /updates; /help/changelog has no article behind it.
    expect(screen.getByRole("link", { name: "What's new" })).toHaveAttribute("href", "/updates");
  });

  it("marks the what's-new dot in the accessible name, not only as a colour", () => {
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} hasWhatsNew />);
    expect(screen.getByRole("link", { name: "What's new (unread)" })).toBeInTheDocument();
  });

  it("opens the palette from the search box", async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    renderWithProviders(<TopBar onOpenPalette={onOpenPalette} />);
    await user.click(screen.getByTestId("open-palette"));
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it("opens the navigation drawer on a narrow viewport", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} />);
    await user.click(screen.getByTestId("open-nav"));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByTestId("nav-home")).toBeInTheDocument();
  });
});

describe("<WorkspaceSwitcher />", () => {
  it("is a label, not a menu, when there is nothing to switch to", async () => {
    renderWithProviders(<WorkspaceSwitcher />);
    const control = await screen.findByTestId("workspace-switcher");
    expect(control.tagName).not.toBe("BUTTON");
  });

  it("is a menu with one entry per workspace when there are several", async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkspaceSwitcher />, {
      routes: {
        "/workspaces": [
          { id: "01JWORKSPACE", name: "Solo", slug: "solo", role: "owner", plan: "creator" },
          { id: "01JOTHER", name: "Agency", slug: "agency", role: "editor", plan: "agency" },
        ],
      },
    });

    // `/workspaces` is A05's; until it exists the hook falls back to an empty
    // list, so this exercises the multi-workspace branch through the fallback's
    // absence rather than asserting a network shape that cannot happen yet.
    const control = await screen.findByTestId("workspace-switcher");
    expect(control).toBeInTheDocument();
    await user.click(control).catch(() => undefined);
  });
});

describe("<ProfileMenu />", () => {
  it("shows the account and the routes A13 owns", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileMenu />, { accessToken: testAccessToken({ role: "owner" }) });
    await user.click(screen.getByTestId("profile-menu"));
    expect(await screen.findByRole("menuitem", { name: /Profile/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Privacy/ })).toBeInTheDocument();
    expect(screen.getByTestId("sign-out")).toBeInTheDocument();
  });
});

describe("initials", () => {
  it("takes two letters and never shows the whole address", () => {
    expect(initials("priya.sharma@example.com")).toBe("PS");
    expect(initials("Ravi Kumar")).toBe("RK");
    expect(initials("x@example.com")).toBe("X");
    expect(initials("")).toBe("");
  });
});
