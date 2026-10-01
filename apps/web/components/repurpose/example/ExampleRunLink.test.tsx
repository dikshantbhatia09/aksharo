import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExampleRunLink } from "./ExampleRunLink";

import { FeatureGallery } from "@/components/repurpose/FeatureGallery";
import { renderWithProviders } from "@/test/harness";

/**
 * "See a finished example" (2026-10-01) is offered only while the owner has
 * set an example run: the product ships with none, and then says nothing.
 */
describe("<ExampleRunLink />", () => {
  it("renders nothing while no example is set", async () => {
    const { fetchMock } = renderWithProviders(<ExampleRunLink withHint />, {
      routes: { "/repurpose/example": { available: false } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByTestId("example-run-link")).toBeNull();
  });

  it("renders nothing when the example cannot be read", async () => {
    const { fetchMock } = renderWithProviders(<ExampleRunLink />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByTestId("example-run-link")).toBeNull();
  });

  it("links to the example once one is set", async () => {
    renderWithProviders(<ExampleRunLink withHint />, {
      routes: { "/repurpose/example": { available: true } },
    });
    expect(await screen.findByTestId("example-run-link")).toHaveAttribute(
      "href",
      "/repurpose/example",
    );
  });

  it("ends the opened feature gallery", async () => {
    window.localStorage.clear();
    renderWithProviders(<FeatureGallery openByDefault />, {
      routes: { "/repurpose/example": { available: true } },
    });
    expect(await screen.findByTestId("example-run-link")).toHaveTextContent(
      "See a finished example",
    );
  });
});
