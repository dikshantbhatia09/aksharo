import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SignUpForm } from "./signup-form";

import { renderWithProviders } from "@/test/harness";

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

  it("goes straight to sign-in guidance when dev auto-verification is on", async () => {
    renderWithProviders(<SignUpForm />, {
      accessToken: null,
      routes: {
        "/auth/signup": { status: "verification_sent", email: "local@example.test" },
      },
      config: { authDevAutoVerify: true },
    });

    await completeSignUp();
    expect(await screen.findByRole("heading", { name: "You can sign in now" })).toBeInTheDocument();
    expect(screen.getByText(/no confirmation click is needed/i)).toBeInTheDocument();
  });
});
