import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StudioRequired } from "./StudioRequired.js";

describe("StudioRequired", () => {
  it("renders the D24/D65 guard copy", () => {
    render(<StudioRequired />);
    expect(screen.getByTestId("studio-required")).toBeInTheDocument();
    expect(screen.getByText(/Resolve Studio required/)).toBeInTheDocument();
  });
});
