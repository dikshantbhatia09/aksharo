import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClientModule from "@montaj/api-client";

import type * as AppShellModule from "./app-shell";

import { AuthCard } from "@/components/auth/auth-card";
import { Providers } from "@/components/providers";
import { SettingsRow, SettingsSection } from "@/components/settings/section";
import { TEST_CONFIG } from "@/test/harness";
import { routerMock } from "@/test/next-router";

const refreshSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session/client", () => ({
  refreshSession,
  persistSession: vi.fn(),
  clearSession: vi.fn(),
  hasSessionCookie: vi.fn(),
}));

/** Nothing here should open a socket; the shell's realtime client is stubbed. */
vi.mock("@montaj/api-client", async () => {
  const actual = await vi.importActual<typeof ApiClientModule>("@montaj/api-client");
  return {
    ...actual,
    RealtimeClient: class {
      subscribe(): void {}
      connect(): void {}
      disconnect(): void {}
    },
  };
});

let AppShell: (typeof AppShellModule)["AppShell"];

beforeEach(async () => {
  ({ AppShell } = await import("./app-shell"));
  refreshSession.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderShell(): void {
  render(
    <Providers config={TEST_CONFIG}>
      <AppShell>
        <p>Shell content</p>
      </AppShell>
    </Providers>,
  );
}

describe("<AppShell />", () => {
  it("turns the httpOnly cookie into an access token on mount", async () => {
    refreshSession.mockResolvedValue({
      accessToken:
        "header.eyJzdWIiOiIwMUpVIiwid3MiOiIwMUpXIiwicm9sZSI6Im93bmVyIiwia2luZCI6IndlYiIsImp0aSI6IjAxSlMiLCJleHAiOjQxMDI0NDQ4MDB9.sig",
      expiresIn: 900,
      workspaceId: "01JW",
      role: "owner",
    });

    renderShell();
    await waitFor(() => {
      expect(refreshSession).toHaveBeenCalledOnce();
    });
    expect(screen.getByText("Shell content")).toBeInTheDocument();
  });

  it("sends the user to sign in when the family is gone", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/login?reason=expired");
    });
  });

  it("puts a skip link first and a focusable main landmark second (08 §6)", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalled();
    });
  });

  it("renders exactly one navigation landmark on a wide viewport", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalled();
    });
  });
});

describe("<AuthCard />", () => {
  it("is a main landmark with a single heading", () => {
    render(
      <AuthCard title="Sign in" subtitle="Welcome back" footer={<span>Footer</span>}>
        <p>Body</p>
      </AuthCard>,
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("omits the subtitle and footer when there are none", () => {
    render(
      <AuthCard title="Sign in">
        <p>Body</p>
      </AuthCard>,
    );
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });
});

describe("<SettingsSection />", () => {
  it("renders a heading, a lead line and its rows", () => {
    render(
      <SettingsSection title="Privacy" description="What we may collect." testId="settings-privacy">
        <SettingsRow
          label="Analytics"
          description="Off by default"
          control={<button>Toggle</button>}
        />
      </SettingsSection>,
    );
    expect(screen.getByTestId("settings-privacy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByText("Off by default")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle" })).toBeInTheDocument();
  });

  it("works without a test id or a row description", () => {
    render(
      <SettingsSection title="Notifications" description="Emails.">
        <SettingsRow label="Digest" control={<span>None</span>} />
      </SettingsSection>,
    );
    expect(screen.getByText("Digest")).toBeInTheDocument();
  });
});
