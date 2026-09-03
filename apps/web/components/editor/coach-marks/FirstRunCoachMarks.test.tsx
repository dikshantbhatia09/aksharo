import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import type { CurrentUser } from "@montaj/api-client";

import { FirstRunCoachMarks } from "./FirstRunCoachMarks";

import { renderWithProviders } from "@/test/harness";

/**
 * M16 (gate-a blocker, following M10/M14): `gate-a.spec.ts` kept failing on
 * the style-picker click because the coach mark's floating callout can sit
 * on top of the very panel it is pointing at (`data-coach-mark="style"` is
 * pinned to the right edge of the editor, leaving the box nowhere to go but
 * over it). A real user hitting that overlap is stuck the same way a test
 * is, so the fix belongs in the component: the callout must let pointer
 * events fall through to whatever is under it, keeping only its own
 * Skip/Next controls clickable.
 */

function baseUser(onboarding: CurrentUser["onboarding"] = {}): CurrentUser {
  return {
    id: "01JUSER",
    email: "creator@example.com",
    emailVerified: true,
    name: "Creator",
    avatarUrl: null,
    locale: "en",
    jurisdiction: "IN",
    ageBracket: "adult",
    marketingOptIn: false,
    onboarding,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    deletedAt: null,
    workspace: { id: "01JWORKSPACE", role: "owner" },
  };
}

/** Mount all three targets exactly as `editor-client.tsx` does (transcript,
 * style, export), so each step's `getBoundingClientRect()` lookup finds a
 * real element to position against — the steps run in that order, so a test
 * that only cares about "style" still has to get past "transcript" first. */
function EditorPanelHarness(): React.JSX.Element {
  return (
    <div>
      <div data-coach-mark="transcript" style={{ position: "relative" }}>
        transcript panel
      </div>
      <div data-coach-mark="style" style={{ position: "relative" }}>
        <button type="button" data-testid="style-picker-button">
          Pick style
        </button>
      </div>
      <span data-coach-mark="export">export</span>
      <FirstRunCoachMarks />
    </div>
  );
}

describe("<FirstRunCoachMarks />", () => {
  it("renders nothing once every step is already dismissed", () => {
    renderWithProviders(<EditorPanelHarness />, {
      routes: { "/me": baseUser({ coachMarksShownAt: "2026-01-01T00:00:00.000Z" }) },
    });
    expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
  });

  it("never blocks a click on the element it highlights, even while active", async () => {
    const user = userEvent.setup();
    let clicked = false;

    function Harness(): React.JSX.Element {
      return (
        <div>
          <div data-coach-mark="transcript" style={{ position: "relative" }}>
            transcript panel
          </div>
          <div data-coach-mark="style" style={{ position: "relative" }}>
            <button
              type="button"
              data-testid="style-picker-button"
              onClick={() => {
                clicked = true;
              }}
            >
              Pick style
            </button>
          </div>
          <span data-coach-mark="export">export</span>
          <FirstRunCoachMarks />
        </div>
      );
    }

    renderWithProviders(<Harness />, { routes: { "/me": baseUser() } });

    // Advance to the "style" step (transcript is first) so the callout is
    // positioned over the style panel, mirroring the editor's real layout.
    await screen.findByTestId("coach-mark");
    await user.click(screen.getByTestId("coach-mark-next"));
    await waitFor(() => {
      expect(screen.getByTestId("coach-mark")).toHaveAttribute("data-coach-mark-step", "style");
    });

    const mark = screen.getByTestId("coach-mark");
    // The regression: the callout used to be a plain positioned box, so it
    // could sit on top of the panel it names and swallow the click.
    expect(mark).toHaveStyle({ pointerEvents: "none" });

    const target = screen.getByTestId("style-picker-button");
    fireEvent.click(target);
    expect(clicked).toBe(true);
  });

  it("keeps its own Skip and Next controls clickable", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditorPanelHarness />, { routes: { "/me": baseUser() } });

    const mark = await screen.findByTestId("coach-mark");
    expect(mark).toHaveStyle({ pointerEvents: "none" });

    const skip = screen.getByTestId("coach-mark-skip");
    expect(skip).toHaveStyle({ pointerEvents: "auto" });

    await user.click(skip);
    await waitFor(() => {
      expect(screen.queryByTestId("coach-mark")).not.toBeInTheDocument();
    });
  });

  it("unmounts entirely (no leftover overlay) once dismissed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EditorPanelHarness />, { routes: { "/me": baseUser() } });

    await screen.findByTestId("coach-mark");
    await user.click(screen.getByTestId("coach-mark-skip"));

    await waitFor(() => {
      expect(document.querySelector('[data-testid="coach-mark"]')).toBeNull();
    });
    // No stray fixed/absolute node left behind that could still intercept
    // pointer events after dismissal.
    expect(document.querySelectorAll(".fixed").length).toBe(0);
  });
});
