import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/admin" }));
const session = vi.hoisted(() => ({
  current: null as null | { accessToken: string; adminRoles: string[]; expiresIn: number },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/admin/admin-session", () => ({
  readAdminSession: () => session.current,
  clearAdminSession: vi.fn(),
}));

import { AdminShell } from "./admin-shell";

describe("AdminShell", () => {
  beforeEach(() => {
    session.current = null;
  });

  it("renders a /ui-kit page as itself, with no step-up gate and no console", async () => {
    nav.pathname = "/ui-kit";
    render(
      <AdminShell>
        <p>kit content</p>
      </AdminShell>,
    );
    expect(await screen.findByText("kit content")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Admin console" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Step up" })).not.toBeInTheDocument();
  });

  it("shows the step-up gate on /admin without a session", async () => {
    nav.pathname = "/admin/users";
    render(
      <AdminShell>
        <p>panel</p>
      </AdminShell>,
    );
    expect(await screen.findByRole("heading", { name: "Step up to continue" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Step up" })).toHaveAttribute("href", "/admin/step-up");
    expect(screen.queryByText("panel")).not.toBeInTheDocument();
  });

  it("marks the section that owns a detail page as the current nav row", async () => {
    nav.pathname = "/admin/users/u1";
    session.current = { accessToken: "t", adminRoles: ["support"], expiresIn: 1800 };
    render(
      <AdminShell>
        <p>detail</p>
      </AdminShell>,
    );
    expect(await screen.findByText("detail")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Evals" })).toHaveAttribute("href", "/admin/evals");
  });
});
