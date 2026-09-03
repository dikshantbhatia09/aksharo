import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AuthDivider, GoogleButton } from "./google-button";

import { renderWithProviders } from "@/test/harness";

describe("Google auth availability", () => {
  it("shows the Google action and divider when OAuth is configured", () => {
    renderWithProviders(
      <>
        <GoogleButton />
        <AuthDivider />
      </>,
      { config: { googleOAuthEnabled: true }, accessToken: null },
    );

    expect(screen.getByTestId("google-signin")).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
  });

  it("hides both when the Google OAuth credentials are absent", () => {
    renderWithProviders(
      <>
        <GoogleButton />
        <AuthDivider />
      </>,
      { config: { googleOAuthEnabled: false }, accessToken: null },
    );

    expect(screen.queryByTestId("google-signin")).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
  });
});
