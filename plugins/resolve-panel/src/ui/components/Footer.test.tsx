import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Footer } from "./Footer.js";

describe("Footer", () => {
  it("renders the version line with host version", () => {
    render(<Footer panelVersion="0.1.0" apiVersion="0.1.0" hostVersion="19.1.0" />);
    expect(screen.getByTestId("footer-version-line").textContent).toBe(
      "Aksharo v0.1.0 · API v0.1.0 · Resolve 19.1.0",
    );
  });

  it("omits the host segment when unknown", () => {
    render(<Footer panelVersion="0.1.0" apiVersion="0.1.0" />);
    expect(screen.getByTestId("footer-version-line").textContent).toBe(
      "Aksharo v0.1.0 · API v0.1.0",
    );
  });

  it("always shows the non-affiliation line", () => {
    render(<Footer panelVersion="0.1.0" apiVersion="0.1.0" />);
    expect(screen.getByTestId("footer-non-affiliation").textContent).toMatch(/independent product/);
  });
});
