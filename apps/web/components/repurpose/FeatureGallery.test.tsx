import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FEATURES, FeatureGallery } from "./FeatureGallery";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders } from "@/test/harness";

describe("<FeatureGallery />", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows what one video gives, and opens a tile into how to get it", async () => {
    renderWithProviders(<FeatureGallery openByDefault />);
    for (const feature of FEATURES) {
      expect(screen.getByTestId(`feature-${feature.key}`)).toHaveTextContent(feature.title);
    }
    await userEvent.click(screen.getByTestId("feature-captions"));
    const detail = await screen.findByTestId("feature-detail");
    expect(within(detail).getAllByRole("img")).toHaveLength(3);
    expect(within(detail).getByTestId("feature-detail-cta")).toHaveAttribute(
      "href",
      "/repurpose/new",
    );
  });

  it("folds away and stays folded", async () => {
    const first = renderWithProviders(<FeatureGallery openByDefault />);
    await userEvent.click(screen.getByTestId("feature-gallery-toggle"));
    expect(screen.queryByTestId("feature-moments")).not.toBeInTheDocument();
    first.unmount();
    renderWithProviders(<FeatureGallery openByDefault />);
    expect(screen.queryByTestId("feature-moments")).not.toBeInTheDocument();
  });

  it("starts folded for a workspace that knows the pipeline", () => {
    renderWithProviders(<FeatureGallery openByDefault={false} />);
    expect(screen.getByTestId("feature-gallery-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("speaks plainly", () => {
    for (const feature of FEATURES) {
      const words = [feature.title, feature.line, feature.about, ...feature.how].join(" ");
      expect(beginnerSafetyViolations(words)).toEqual([]);
    }
  });
});
