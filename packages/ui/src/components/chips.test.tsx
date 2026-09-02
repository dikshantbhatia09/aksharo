import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { isAppleShortcutPlatform, LangChip, ShortcutHint, shortcutKeys, StatusChip } from "./chips";
import { EmptyState } from "./empty-state";

describe("shortcutKeys", () => {
  it("leaves Windows and Linux keys alone", () => {
    expect(shortcutKeys(["Ctrl", "K"], false)).toEqual(["Ctrl", "K"]);
  });

  it("uses the Apple glyphs on a Mac", () => {
    expect(shortcutKeys(["Ctrl", "Shift", "Alt", "P"], true)).toEqual(["⌘", "⇧", "⌥", "P"]);
  });

  it("detects Apple platforms from the platform string", () => {
    expect(isAppleShortcutPlatform("MacIntel")).toBe(true);
    expect(isAppleShortcutPlatform("Win32")).toBe(false);
  });
});

describe("<ShortcutHint />", () => {
  it("renders each key and hides them from the accessibility tree", () => {
    const { container } = render(<ShortcutHint keys={["Ctrl", "K"]} />);
    expect(container.querySelectorAll("kbd")).toHaveLength(2);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("<StatusChip />", () => {
  it("maps a status onto its signal colour and readable label", () => {
    render(<StatusChip status="processing" />);
    expect(screen.getByTestId("status-chip")).toHaveTextContent("Working");
    expect(screen.getByTestId("status-chip").className).toContain("text-proposed");
  });

  it("uses the rejected signal for a failure", () => {
    render(<StatusChip status="failed" />);
    expect(screen.getByTestId("status-chip").className).toContain("text-rejected");
  });
});

describe("<LangChip />", () => {
  it("shows Hinglish for the Roman Hindi tag", () => {
    render(<LangChip language="hi-Latn" />);
    const chip = screen.getByTestId("lang-chip");
    expect(chip).toHaveTextContent("Hinglish");
    expect(chip).toHaveAttribute("lang", "hi-Latn");
    expect(chip).toHaveAttribute("data-script", "devanagari");
  });

  it("marks a Latin language so no Indic face is requested", () => {
    render(<LangChip language="en" />);
    expect(screen.getByTestId("lang-chip")).toHaveAttribute("data-script", "latin");
  });

  it("falls back to the tag itself", () => {
    render(<LangChip language="xx" />);
    expect(screen.getByTestId("lang-chip")).toHaveTextContent("xx");
  });
});

describe("<EmptyState />", () => {
  it("says what goes here and offers one next step", () => {
    render(
      <EmptyState
        title="No projects yet"
        description="Drop a clip to get captions in about a minute."
        action={<button type="button">Try with a sample</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try with a sample" })).toBeInTheDocument();
  });
});
