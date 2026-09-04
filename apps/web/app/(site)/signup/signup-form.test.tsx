import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SignUpForm } from "./signup-form";

import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

// `persistSession` posts to this app's own origin with a relative URL, which the
// harness fetch double cannot parse — the same stub `app-shell.test.tsx` uses.
vi.mock("@/lib/session/client", () => ({
  persistSession: vi.fn(),
  clearSession: vi.fn(),
  refreshSession: vi.fn(),
  hasSessionCookie: vi.fn(),
}));

const TOKENS = {
  accessToken: "access.token.value",
  refreshToken: "refresh.token.value",
  expiresIn: 900,
  workspaceId: "01JWORKSPACE",
  role: "owner",
};

async function completeSignUp(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Local Developer");
  await user.type(screen.getByLabelText("Email"), "local@example.test");
  await user.type(screen.getByLabelText("Password"), "a secure local password");
  await user.click(screen.getByTestId("signup-continue"));
  await user.type(screen.getByLabelText("Date of birth"), "1990-01-01");
  await user.click(screen.getByTestId("age-consent-submit"));
}

describe("<SignUpForm /> completion", () => {
  it("keeps the check-your-inbox step when auto-verification is off", async () => {
    renderWithProviders(<SignUpForm />, {
      accessToken: null,
      routes: {
        "/auth/signup": { status: "verification_sent", email: "local@example.test" },
      },
      config: { authDevAutoVerify: false },
    });

    await completeSignUp();
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
  });

  // F07-D1 replaces this case's old expectation. Dev auto-verify means the
  // account is already usable, so the confirmation screen asked for a click that
  // does not exist; signup now signs the user in and lands them on Home.
  it("signs the new account in and lands on Home when dev auto-verification is on", async () => {
    const { fetchMock } = renderWithProviders(<SignUpForm />, {
      accessToken: null,
      routes: {
        "/auth/signup": { status: "verification_sent", email: "local@example.test" },
        "/auth/login": TOKENS,
      },
      config: { authDevAutoVerify: true },
    });

    await completeSignUp();

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/home");
    });
    expect(routerMock.refresh).toHaveBeenCalled();

    // The login really was issued, with the credentials just typed.
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/auth/login"));
    expect(loginCall).toBeDefined();
    expect(JSON.parse(String(loginCall?.[1]?.body))).toMatchObject({
      kind: "web",
      email: "local@example.test",
      password: "a secure local password",
    });

    // And the dead-end confirmation screen is gone.
    expect(screen.queryByRole("heading", { name: "You can sign in now" })).toBeNull();
  });

  it("falls back to the confirmation screen if that sign-in does not work", async () => {
    renderWithProviders(<SignUpForm />, {
      accessToken: null,
      routes: {
        "/auth/signup": { status: "verification_sent", email: "local@example.test" },
        // `/auth/login` is absent, so the harness answers 404: the server did not
        // in fact auto-verify. The user must not be stranded on the form.
      },
      config: { authDevAutoVerify: true },
    });

    await completeSignUp();
    expect(await screen.findByRole("heading", { name: "You can sign in now" })).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalledWith("/home");
  });
});
