import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocalProjectsSection } from "./local-projects-section";

import type { AksharoDesktopWindowApi } from "@/lib/desktop";

import { renderWithProviders } from "@/test/harness";

function installDesktopApi(local: AksharoDesktopWindowApi["local"] | undefined): void {
  (window as unknown as { aksharoDesktop?: Partial<AksharoDesktopWindowApi> }).aksharoDesktop = {
    version: "1.0.0",
    platform: "win32",
    local,
  } as AksharoDesktopWindowApi;
}

describe("<LocalProjectsSection />", () => {
  afterEach(() => {
    delete (window as unknown as { aksharoDesktop?: unknown }).aksharoDesktop;
  });

  it("renders nothing outside the desktop shell", () => {
    renderWithProviders(<LocalProjectsSection />);
    expect(screen.queryByTestId("local-projects-section")).toBeNull();
    expect(screen.queryByTestId("local-projects-upgrade")).toBeNull();
  });

  it("shows the upgrade copy when local mode is disabled (Free plan)", async () => {
    installDesktopApi({
      isEnabled: async () => false,
      listProjects: async () => [],
      createProject: async () => {
        throw new Error("not called");
      },
      openProject: async () => {
        throw new Error("not called");
      },
      deleteProject: async () => ({ ok: true }),
      importMedia: async () => {
        throw new Error("not called");
      },
      listMedia: async () => [],
      transcribe: async () => ({}),
      align: async () => ({}),
      saveEdgSnapshot: async () => {
        throw new Error("not called");
      },
      latestSnapshot: async () => null,
      runExport: async () => {
        throw new Error("not called");
      },
      listExports: async () => [],
    });

    renderWithProviders(<LocalProjectsSection />);

    await waitFor(() => expect(screen.getByTestId("local-projects-upgrade")).toBeTruthy());
    expect(screen.getByText(/Upgrade your plan/i)).toBeTruthy();
  });

  it("lists local projects when enabled (Starter+)", async () => {
    installDesktopApi({
      isEnabled: async () => true,
      listProjects: async () => [
        {
          id: "lp1",
          title: "My local clip",
          aspect: "9:16",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      createProject: async () => {
        throw new Error("not called");
      },
      openProject: async () => {
        throw new Error("not called");
      },
      deleteProject: async () => ({ ok: true }),
      importMedia: async () => {
        throw new Error("not called");
      },
      listMedia: async () => [],
      transcribe: async () => ({}),
      align: async () => ({}),
      saveEdgSnapshot: async () => {
        throw new Error("not called");
      },
      latestSnapshot: async () => null,
      runExport: async () => {
        throw new Error("not called");
      },
      listExports: async () => [],
    });

    renderWithProviders(<LocalProjectsSection />);

    await waitFor(() => expect(screen.getByText("My local clip")).toBeTruthy());
  });
});
