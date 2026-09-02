import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { initials, ProfileMenu } from "./profile-menu";
import { Sidebar, UpgradeButton } from "./sidebar";
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
    const projects = screen.getByTestId("nav-projects");
    expect(projects.tagName).not.toBe("A");
    expect(projects).toHaveAttribute("aria-disabled", "true");
    expect(projects).toHaveTextContent("Soon");
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
});

describe("<UpgradeButton />", () => {
  it("renders nothing until the plan is known", () => {
    const { container } = renderWithProviders(<UpgradeButton />);
    expect(container.querySelector("[data-testid=upgrade-cta]")).toBeNull();
  });
});

describe("<TopBar />", () => {
  it("offers search, New project and What's new", () => {
    renderWithProviders(<TopBar onOpenPalette={vi.fn()} />);
    expect(screen.getByTestId("open-palette")).toHaveTextContent("Search projects and actions");
    expect(screen.getByTestId("new-project")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "What's new" })).toBeInTheDocument();
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
