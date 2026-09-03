import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Footer } from "./Footer.js";

describe("Footer", () => {
  it("renders the version line", () => {
    render(<Footer panelVersion="0.1.0" hostVersion="24.0.0" />);
    expect(screen.getByTestId("footer-version-line")).toHaveTextContent(
      "Aksharo Panel v0.1.0 · After Effects 24.0.0",
    );
  });

  it("omits the host version segment when unknown", () => {
    render(<Footer panelVersion="0.1.0" />);
    expect(screen.getByTestId("footer-version-line")).toHaveTextContent("Aksharo Panel v0.1.0");
  });

  it("always renders the D65 non-affiliation line", () => {
    render(<Footer panelVersion="0.1.0" />);
    expect(screen.getByTestId("footer-non-affiliation")).toHaveTextContent(
      /not affiliated with or endorsed by Adobe/,
    );
  });
});
