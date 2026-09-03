import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UpdateBanner } from "./UpdateBanner.js";

describe("UpdateBanner", () => {
  it("renders nothing when show is false", () => {
    const { container } = render(
      <UpdateBanner state={{ show: false, severity: "none" }} currentVersion="0.1.0" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the update-available banner", () => {
    render(
      <UpdateBanner
        state={{ show: true, severity: "update-available", latestVersion: "0.2.0" }}
        currentVersion="0.1.0"
      />,
    );
    expect(screen.getByTestId("update-banner").textContent).toMatch(/0\.2\.0/);
  });
});
