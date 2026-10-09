import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  COPILOT_PROMPT_EXAMPLES,
  COPILOT_SUGGESTION_CHIPS,
  CopilotBar,
  isChipActive,
} from "./copilot-bar";
import {
  EMPTY_RUN_SETUP,
  RunSetupFields,
  runSetupRequest,
  type RunSetupValue,
} from "./RunSetupFields";

function ControlledCopilot({
  initial = "",
  error,
}: {
  readonly initial?: string;
  readonly error?: string;
}): React.ReactElement {
  const [topic, setTopic] = React.useState(initial);
  return <CopilotBar value={topic} onChange={setTopic} {...(error ? { error } : {})} />;
}

describe("CopilotBar (Pillar 2 §06 Topic & Prompt Co-Pilot)", () => {
  it("renders all 4 suggestion chips and conversational prompt examples", () => {
    render(<CopilotBar value="" onChange={vi.fn()} />);

    expect(screen.getByTestId("copilot-bar")).toBeInTheDocument();
    expect(screen.getByTestId("copilot-bar-input")).toBeInTheDocument();

    for (const chip of COPILOT_SUGGESTION_CHIPS) {
      const btn = screen.getByTestId(`copilot-chip-${chip.key}`);
      expect(btn).toHaveTextContent(chip.label);
      expect(btn).toHaveAttribute("aria-pressed", "false");
    }

    expect(screen.getByTestId("copilot-chip-actionable-tips")).toHaveTextContent("Actionable Tips");
    expect(screen.getByTestId("copilot-chip-controversial-takes")).toHaveTextContent(
      "Controversial Takes",
    );
    expect(screen.getByTestId("copilot-chip-funny-moments")).toHaveTextContent("Funny Moments");
    expect(screen.getByTestId("copilot-chip-key-metrics-numbers")).toHaveTextContent(
      "Key Metrics & Numbers",
    );

    COPILOT_PROMPT_EXAMPLES.forEach((example, idx) => {
      expect(screen.getByTestId(`copilot-example-${idx}`)).toHaveTextContent(example);
    });
  });

  it("applies and toggles suggestion chips on click", async () => {
    const user = userEvent.setup();
    render(<ControlledCopilot />);

    const actionableChip = screen.getByTestId("copilot-chip-actionable-tips");
    await user.click(actionableChip);

    expect(actionableChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("copilot-bar-input")).toHaveValue("Actionable Tips");
    expect(screen.getByTestId("copilot-active-badge")).toHaveTextContent(
      "Strict Topic Match Active",
    );

    // Clicking a different chip switches selection
    const funnyChip = screen.getByTestId("copilot-chip-funny-moments");
    await user.click(funnyChip);
    expect(funnyChip).toHaveAttribute("aria-pressed", "true");
    expect(actionableChip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("copilot-bar-input")).toHaveValue("Funny Moments");

    // Clicking the active chip again clears it
    await user.click(funnyChip);
    expect(funnyChip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("copilot-bar-input")).toHaveValue("");
    expect(screen.queryByTestId("copilot-active-badge")).toBeNull();
  });

  it("supports natural language prompts and clear button", async () => {
    const user = userEvent.setup();
    render(<ControlledCopilot />);

    const input = screen.getByTestId("copilot-bar-input");
    await user.type(input, "Find moments explaining customer acquisition cost");

    expect(input).toHaveValue("Find moments explaining customer acquisition cost");
    expect(screen.getByTestId("copilot-active-badge")).toBeInTheDocument();

    const clearBtn = screen.getByTestId("copilot-bar-clear");
    await user.click(clearBtn);
    expect(input).toHaveValue("");
    expect(screen.queryByTestId("copilot-bar-clear")).toBeNull();
  });

  it("applies conversational prompt examples on click and displays validation errors", async () => {
    const user = userEvent.setup();
    render(<ControlledCopilot error="Say a little more, like “money habits”." />);

    expect(screen.getByTestId("copilot-bar-error")).toHaveTextContent(
      "Say a little more, like “money habits”.",
    );

    const example0 = screen.getByTestId("copilot-example-0");
    await user.click(example0);
    expect(screen.getByTestId("copilot-bar-input")).toHaveValue(COPILOT_PROMPT_EXAMPLES[0]);
    expect(example0).toHaveAttribute("aria-pressed", "true");
  });

  it("syncs with RunSetupFields steering-topic input and discovery request payload", async () => {
    const user = userEvent.setup();
    let latest: RunSetupValue = EMPTY_RUN_SETUP;

    function SetupHarness(): React.ReactElement {
      const [val, setVal] = React.useState<RunSetupValue>(EMPTY_RUN_SETUP);
      latest = val;
      return <RunSetupFields value={val} onChange={setVal} problems={{}} />;
    }

    render(<SetupHarness />);

    await user.click(screen.getByTestId("copilot-chip-controversial-takes"));
    expect(screen.getByTestId("steering-topic")).toHaveValue("Controversial Takes");
    expect(runSetupRequest(latest).discovery.topic).toBe("Controversial Takes");

    await user.click(screen.getByTestId("copilot-chip-key-metrics-numbers"));
    expect(screen.getByTestId("steering-topic")).toHaveValue("Key Metrics & Numbers");
    expect(runSetupRequest(latest).discovery.topic).toBe("Key Metrics & Numbers");
  });

  it("matches chip activity case-insensitively", () => {
    expect(isChipActive("  actionable tips ", "Actionable Tips")).toBe(true);
    expect(isChipActive("crypto crash", "Actionable Tips")).toBe(false);
  });
});
