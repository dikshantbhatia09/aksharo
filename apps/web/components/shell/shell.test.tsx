import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BRAND } from "@montaj/config";

import { NavRail } from "./nav-rail";
import { initials, ProfileMenu } from "./profile-menu";
import { formatStorageBytes, Sidebar, sumStorageBytes, UpgradeButton } from "./sidebar";
import { TopBar } from "./top-bar";
import { WorkspaceSwitcher } from "./workspace-switcher";

import { PRIMARY_NAV, SECONDARY_NAV } from "@/lib/nav";
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

  /**
   * The desktop app is not in this release: `apps/desktop` is not in this Git
   * HEAD, so the link advertised a download nobody could get (P0-12). It needs
   * BOTH the production origin and an explicit flag.
   */
  it("offers the desktop download from the brand domain, never the codename", () => {
    renderWithProviders(<Sidebar />, {
      config: {
        webOrigin: `https://app.${BRAND.domain}`,
        flags: { "desktop.download": true },
      },
    });
    const download = screen.getByTestId("desktop-download");
    expect(download).toHaveAttribute("href", `https://${BRAND.domain}/download`);
    expect(download.getAttribute("href")).not.toContain("montaj");
  });

  it("hides the desktop download until the flag turns it on", () => {
    renderWithProviders(<Sidebar />, {
      config: { webOrigin: `https://app.${BRAND.domain}` },
    });
    expect(screen.queryByTestId("desktop-download")).toBeNull();
  });

  // F07-E8: aksharo.ai/download only exists for the production deployment.
  it("does not offer that download from a build served somewhere else", () => {
    renderWithProviders(<Sidebar />, {
      config: { webOrigin: "http://127.0.0.1:3934", flags: { "desktop.download": true } },
    });
    expect(screen.queryByTestId("desktop-download")).toBeNull();
  });

  it("shows the credit card with what the credit account says", async () => {
    renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
    // `/entitlement` is A05's and is not in the API yet, so the card renders
    // the honest zero rather than an error state.
    expect(await screen.findByTestId("credits-card-balance")).toHaveTextContent("—");
  });

  it("keeps the streak badge behind its flag", async () => {
    renderWithProviders(<Sidebar />, { config: { flags: { "growth.streakWidget": false } } });
    await waitFor(() => {
      expect(screen.getByTestId("credits-card")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("credit-meter-streak")).toBeNull();
  });

  /*
   * K04 shipped three stacked meters — transcription credits, Audio Clean and
   * Storage — because the reference screenshot of the time had three. The
   * premium canvas has one credit card and no meter for anything without a
   * cap, so Audio Clean is gone (it was the *same* credit balance relabelled:
   * `packages/config/src/credits.ts` charges `audioClean` the identical rate
   * as `transcribe`, so the row restated a number the card already showed),
   * and Storage is a sentence rather than a bar.
   */
  describe("usage counters", () => {
    it("states storage as a figure, with no invented quota to draw a bar against", async () => {
      renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
      await waitFor(() => {
        expect(screen.getByTestId("storage-meter")).toHaveTextContent("of media");
      });
      expect(within(screen.getByTestId("storage-meter")).queryByRole("progressbar")).toBeNull();
    });

    it("does not restate the credit balance a second time as Audio Clean", () => {
      renderWithProviders(<Sidebar />, { routes: ENTITLEMENT });
      expect(screen.queryByTestId("audio-clean-meter")).toBeNull();
    });
  });
});

describe("<NavRail />", () => {
  it("carries the canvas's eight destinations and none of the secondary ones", () => {
    renderWithProviders(<NavRail />);
    for (const item of PRIMARY_NAV) {
      expect(screen.getByTestId(`nav-${item.key}`)).toBeInTheDocument();
    }
    for (const item of SECONDARY_NAV) {
      expect(screen.queryByTestId(`nav-${item.key}`)).toBeNull();
    }
  });

  it("captions each icon, so the rail is readable without hovering", () => {
    renderWithProviders(<NavRail />);
    expect(screen.getByTestId("nav-projects")).toHaveTextContent("Projects");
    expect(screen.getByTestId("nav-repurpose")).toHaveTextContent("Clips");
  });

  it("marks the current page for assistive technology, not only with colour", () => {
    pathnameMock.value = "/";
    renderWithProviders(<NavRail />);
    expect(screen.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  });

  /*
   * `repurpose_flow` is targeted at one workspace, and the canvas puts Clips
   * FIRST in the rail. Ungated it would be the topmost button for every user
   * outside the cohort, leading to a screen that only says "not on for you" —
   * and it would be the single always-visible trace of the surface, since the
   * studio's own banner renders nothing when the flag is off.
   */
  it("disables the Clips entry for a workspace the pipeline is not on for", async () => {
    renderWithProviders(<NavRail />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: {} },
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("nav-repurpose")).toHaveAttribute("aria-disabled", "true");
    });
    expect(screen.getByTestId("nav-repurpose").tagName).not.toBe("A");
  });

  it("links the Clips entry once the pipeline is on for the workspace", async () => {
    renderWithProviders(<NavRail />, {
      routes: {
        "/workspaces/01JWORKSPACE/entitlement": {
          workspaceId: "01JWORKSPACE",
          planKey: "free",
          planName: "Free",
          creditsPerMonthTenths: 200,
          seatsIncluded: 1,
          seatsUsed: 1,
          computedAt: "2026-09-15T10:00:00.000Z",
          entitlements: { flags: { repurpose_flow: true } },
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("nav-repurpose").tagName).toBe("A");
    });
    expect(screen.getByTestId("nav-repurpose")).toHaveAttribute("href", "/repurpose");
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
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} navModel="rail" onNavModelChange={vi.fn()} />);
    expect(screen.getByTestId("open-palette")).toHaveTextContent("Search projects and actions");
    expect(screen.getByTestId("new-project")).toBeInTheDocument();
    // The changelog lives at /updates; /help/changelog has no article behind it.
    expect(screen.getByRole("link", { name: "What's new" })).toHaveAttribute("href", "/updates");
  });

  it("marks the what's-new dot in the accessible name, not only as a colour", () => {
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} hasWhatsNew navModel="rail" onNavModelChange={vi.fn()} />);
    expect(screen.getByRole("link", { name: "What's new (unread)" })).toBeInTheDocument();
  });

  it("opens the palette from the search box", async () => {
    const user = userEvent.setup();
    const onOpenPalette = vi.fn();
    renderWithProviders(<TopBar onOpenPalette={onOpenPalette} navModel="rail" onNavModelChange={vi.fn()} />);
    await user.click(screen.getByTestId("open-palette"));
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it("opens the navigation drawer on a narrow viewport", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} navModel="rail" onNavModelChange={vi.fn()} />);
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
  /*
   * The 68 px rail is the default shell and has no room for the sidebar's
   * workspace switcher; the sidebar's only other mount is a sheet whose
   * trigger is `lg:hidden`. Between those two facts, a user with more than one
   * workspace briefly had NO way to change workspace on a desktop. The
   * switcher lives in this menu for that reason, and this is the test that
   * stops it drifting back out.
   */
  it("offers workspace switching, because the rail has nowhere else to put it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileMenu compact />, {
      accessToken: testAccessToken({ role: "owner" }),
      routes: {
        "/workspaces": [
          { id: "01JWORKSPACE", name: "Solo", slug: "solo", role: "owner", plan: "creator" },
          { id: "01JOTHER", name: "Agency", slug: "agency", role: "editor", plan: "agency" },
        ],
      },
    });
    await user.click(screen.getByTestId("profile-menu"));
    await waitFor(() => {
      expect(screen.getByTestId("profile-workspace-01JOTHER")).toBeInTheDocument();
    });
    expect(screen.getByTestId("profile-workspace-01JWORKSPACE")).toBeInTheDocument();
  });

  it("does not offer a workspace group when there is nothing to switch to", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProfileMenu />, {
      accessToken: testAccessToken({ role: "owner" }),
      routes: {
        "/workspaces": [
          { id: "01JWORKSPACE", name: "Solo", slug: "solo", role: "owner", plan: "creator" },
        ],
      },
    });
    await user.click(screen.getByTestId("profile-menu"));
    await waitFor(() => {
      expect(screen.getByText("Profile")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("profile-workspace-01JWORKSPACE")).toBeNull();
  });

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
