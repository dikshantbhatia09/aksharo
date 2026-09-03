import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PromptedEditBox } from "./PromptedEditBox";

import { renderWithProviders } from "@/test/harness";

const PROJECT = "01JPROJECT0000000000000000";

const PLAN_RESPONSE = {
  id: "01JPLAN00000000000000000000",
  prompt: "Cut the silences and add some background music",
  engine: "flash",
  passes: [
    { kind: "autocut", params: { preset: "standard", engine: "flash" } },
    { kind: "music", params: { engine: "flash" } },
  ],
  rationale: [
    "The prompt asks to remove dead air, so an autocut pass runs first.",
    "The prompt asks for background music, so a music pass runs.",
  ],
  status: "planned",
  holdTenths: 45,
  holdCredits: "4.5",
  createdAt: "2026-09-03T00:00:00.000Z",
};

const RUN_RESPONSE = {
  planId: PLAN_RESPONSE.id,
  jobId: "01JJOB0000000000000000000000",
  firstPassKind: "autocut",
  status: "running",
  holdTenths: 45,
  holdCredits: "4.5",
};

describe("PromptedEditBox", () => {
  it("shows a client-side hold estimate before a plan exists", () => {
    renderWithProviders(
      <PromptedEditBox projectId={PROJECT} sourceDurationMs={90_000} />,
    );
    expect(screen.getByTestId("prompted-edit-preplan-estimate")).toHaveTextContent(
      /Estimated hold: [\d.]+ credits/,
    );
  });

  it("plans an edit and shows the plan preview sheet with passes, rationale and credits", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PromptedEditBox projectId={PROJECT} sourceDurationMs={90_000} />,
      { routes: { [`/projects/${PROJECT}/prompted-edits`]: PLAN_RESPONSE } },
    );

    await user.type(
      screen.getByTestId("prompted-edit-prompt"),
      "Cut the silences and add some background music",
    );
    await user.click(screen.getByTestId("prompted-edit-plan-button"));

    await waitFor(() => expect(screen.getByTestId("prompted-edit-preview-sheet")).toBeVisible());

    const chips = screen.getByTestId("plan-pass-chips");
    expect(chips).toHaveTextContent("Autocut");
    expect(chips).toHaveTextContent("Music");

    const rationale = screen.getByTestId("plan-rationale");
    expect(rationale.children).toHaveLength(2);

    expect(screen.getByTestId("plan-credits-estimate")).toHaveTextContent("4.5");
  });

  it("runs the plan and shows the first pass's realtime progress affordance", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PromptedEditBox projectId={PROJECT} sourceDurationMs={90_000} />,
      {
        routes: {
          [`/projects/${PROJECT}/prompted-edits`]: PLAN_RESPONSE,
          [`/projects/${PROJECT}/prompted-edits/${PLAN_RESPONSE.id}/run`]: RUN_RESPONSE,
        },
      },
    );

    await user.type(screen.getByTestId("prompted-edit-prompt"), "Cut the silences");
    await user.click(screen.getByTestId("prompted-edit-plan-button"));
    await waitFor(() => expect(screen.getByTestId("prompted-edit-preview-sheet")).toBeVisible());

    await user.click(screen.getByTestId("confirm-run-prompted-edit"));

    await waitFor(() =>
      expect(screen.queryByTestId("prompted-edit-preview-sheet")).not.toBeInTheDocument(),
    );
  });

  it("shows an error when planning fails", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PromptedEditBox projectId={PROJECT} sourceDurationMs={90_000} />,
      {
        routes: {
          [`/projects/${PROJECT}/prompted-edits`]: new Response(
            JSON.stringify({
              error: { code: "prompted_edit/guardrail_violation", message: "budget exceeded" },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
        },
      },
    );

    await user.type(screen.getByTestId("prompted-edit-prompt"), "Do everything at once");
    await user.click(screen.getByTestId("prompted-edit-plan-button"));

    await waitFor(() => expect(screen.getByTestId("prompted-edit-plan-error")).toBeVisible());
  });

  it("disables the plan button until a prompt is entered", () => {
    renderWithProviders(<PromptedEditBox projectId={PROJECT} sourceDurationMs={90_000} />);
    expect(screen.getByTestId("prompted-edit-plan-button")).toBeDisabled();
  });
});
