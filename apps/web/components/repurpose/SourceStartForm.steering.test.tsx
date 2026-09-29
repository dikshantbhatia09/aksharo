import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_START_FORM,
  SourceStartForm,
  validateStartForm,
  type StartFormValue,
} from "./SourceStartForm";

/**
 * Steering on the start form (2026-09-29): what the clips should be about,
 * how long they are, and what of the video to skip - offered only when we pick
 * the moments.
 */
const LINK: StartFormValue = {
  ...EMPTY_START_FORM,
  url: "https://youtu.be/dQw4w9WgXcQ",
  rightsAttested: true,
  sourceLanguage: "hi-Latn",
};

function Harness({
  initial = LINK,
  onSubmit,
  onValue,
}: {
  readonly initial?: StartFormValue;
  readonly onSubmit: () => void;
  readonly onValue?: (value: StartFormValue) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<StartFormValue>(initial);
  onValue?.(value);
  return <SourceStartForm value={value} onChange={setValue} onSubmit={onSubmit} />;
}

describe("<SourceStartForm /> steering", () => {
  it("offers a topic, a clip length (Medium to start) and the skips when we pick the moments", () => {
    render(<Harness onSubmit={() => undefined} />);
    expect(screen.getByTestId("steering-fields")).toBeInTheDocument();
    expect(screen.getByLabelText("What should the clips be about? (optional)")).toHaveAttribute(
      "placeholder",
      "money habits, startup failures",
    );
    expect(screen.getByTestId("clip-length-medium")).toBeChecked();
    expect(screen.getByText("(15–35 s)")).toBeInTheDocument();
    expect(screen.getByTestId("steering-skip-intro")).toBeInTheDocument();
    expect(screen.getByTestId("steering-skip-outro")).toBeInTheDocument();
  });

  it("hides them for 'I know the timestamps', where there is nothing to steer", async () => {
    const user = userEvent.setup();
    render(<Harness onSubmit={() => undefined} />);
    await user.click(screen.getByTestId("method-manual"));
    expect(screen.queryByTestId("steering-fields")).toBeNull();
    // The Autopilot switch is where it always was.
    expect(screen.getByTestId("autopilot-switch")).toBeInTheDocument();
  });

  it("holds what was typed and chosen", async () => {
    const user = userEvent.setup();
    let latest: StartFormValue | undefined;
    render(
      <Harness
        onSubmit={() => undefined}
        onValue={(value) => {
          latest = value;
        }}
      />,
    );
    await user.type(screen.getByTestId("steering-topic"), "money habits");
    await user.click(screen.getByTestId("clip-length-short"));
    await user.type(screen.getByTestId("steering-skip-intro"), "2");
    await user.type(screen.getByTestId("steering-skip-outro"), "1.5");
    expect(latest).toMatchObject({
      topic: "money habits",
      clipLength: "short",
      skipIntro: "2",
      skipOutro: "1.5",
    });
  });

  it("does not submit a skip past half an hour, and says why at the field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await user.type(screen.getByTestId("steering-skip-intro"), "45");
    await user.click(screen.getByTestId("start-run"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("error-skip")).toHaveTextContent(
      "Type a number of minutes from 0 to 30.",
    );
    expect(screen.getByTestId("steering-skip-intro")).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses a one-letter topic, and never blocks a manual run over hidden fields", () => {
    expect(validateStartForm({ ...LINK, topic: "x" }).topic).toBe(
      "Say a little more, like “money habits”.",
    );
    expect(validateStartForm({ ...LINK, topic: "money habits", skipOutro: "5" })).toEqual({});
    expect(
      validateStartForm({
        ...LINK,
        method: "manual",
        requestedCandidates: 0,
        topic: "x",
        skipIntro: "99",
      }),
    ).toEqual({});
  });
});
