import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AddMomentForm } from "./AddMomentForm";

import { renderWithProviders } from "@/test/harness";

/**
 * "Add a moment by time" (clips hardening, 2026-09-26): the manual path that
 * "I know the timestamps" promised, and the way out of an empty discovery. A
 * typo is caught at the field, against the same bounds the API enforces.
 */
const RUN_ID = "01JS0000000000000000000RUN";
const CANDIDATES = `/repurpose/runs/${RUN_ID}/candidates`;

function posted(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): number {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      (init as RequestInit | undefined)?.method === "POST" &&
      new URL(String(input)).pathname === CANDIDATES,
  ).length;
}

async function submit(start: string, end: string): Promise<void> {
  const user = userEvent.setup();
  if (start !== "") await user.type(screen.getByTestId("add-moment-start"), start);
  if (end !== "") await user.type(screen.getByTestId("add-moment-end"), end);
  await user.click(screen.getByTestId("add-moment-submit"));
}

describe("<AddMomentForm /> on a phone and in use", () => {
  // `inputmode="numeric"` opens a digits-only pad on iPhone (and most Android
  // keyboards) with no ":" key and no way to switch: m:ss could not be typed,
  // so the manual path — and the way out of an empty discovery — was closed on
  // every phone.
  it("does not ask for a number pad, which has no ':' key", () => {
    renderWithProviders(<AddMomentForm runId={RUN_ID} available />);
    for (const testId of ["add-moment-start", "add-moment-end"]) {
      const mode = screen.getByTestId(testId).getAttribute("inputmode") ?? "text";
      expect(mode, testId).toBe("text");
    }
  });

  it("asks to stay open once it is used, so the page does not fold it away", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(
      <AddMomentForm runId={RUN_ID} available open onOpenChange={onOpenChange} />,
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("add-moment-start"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe("<AddMomentForm />", () => {
  it("refuses a moment under 3 seconds without asking the server", async () => {
    const { fetchMock } = renderWithProviders(
      <AddMomentForm runId={RUN_ID} durationMs={600_000} available />,
    );
    await submit("0:10", "0:12");
    expect(
      await screen.findByText("A moment has to be at least 3 seconds long."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("add-moment-end")).toHaveAttribute("aria-invalid", "true");
    expect(posted(fetchMock)).toBe(0);
  });

  it("refuses a moment over 3 minutes", async () => {
    renderWithProviders(<AddMomentForm runId={RUN_ID} durationMs={600_000} available />);
    await submit("0:00", "3:01");
    expect(await screen.findByText("A moment can be at most 3 minutes long.")).toBeInTheDocument();
  });

  it("keeps the moment inside the video when its length is known", async () => {
    renderWithProviders(<AddMomentForm runId={RUN_ID} durationMs={60_000} available />);
    expect(screen.getByText(/The video is 1:00 long\./)).toBeInTheDocument();
    await submit("0:40", "1:10");
    expect(await screen.findByText("The video ends at 1:00.")).toBeInTheDocument();
  });

  it("says how to type a time it cannot read", async () => {
    renderWithProviders(<AddMomentForm runId={RUN_ID} available />);
    await submit("ten seconds", "");
    expect(await screen.findByText("Type the start as m:ss, like 1:05.")).toBeInTheDocument();
    expect(screen.getByText("Type the end as m:ss, like 1:40.")).toBeInTheDocument();
  });

  it("shows a refusal from the server in plain words", async () => {
    const { fetchMock } = renderWithProviders(<AddMomentForm runId={RUN_ID} available />, {
      routes: {
        [CANDIDATES]: new Response(
          JSON.stringify({
            error: { code: "repurpose/clip_bounds_invalid", message: "startMs out of range" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await submit("1:00:05", "1:00:40");
    expect(await screen.findByTestId("add-moment-error")).toHaveTextContent(
      "Those times do not work. A moment is 3 seconds to 3 minutes long, inside the video.",
    );
    expect(screen.queryByText("startMs out of range")).toBeNull();
    expect(posted(fetchMock)).toBe(1);
  });

  it("is shown but closed until the transcript exists", () => {
    renderWithProviders(<AddMomentForm runId={RUN_ID} available={false} />);
    expect(screen.getByTestId("add-moment-start")).toBeDisabled();
    expect(screen.getByTestId("add-moment-submit")).toBeDisabled();
    expect(screen.getByText(/as soon as the transcript is ready/)).toBeInTheDocument();
  });

  it("collapses to one button when the page closes it", async () => {
    const user = userEvent.setup();
    let opened = false;
    renderWithProviders(
      <AddMomentForm
        runId={RUN_ID}
        available
        open={false}
        onOpenChange={(next) => {
          opened = next;
        }}
      />,
    );
    expect(screen.queryByTestId("add-moment-form")).toBeNull();
    await user.click(screen.getByTestId("add-moment-toggle"));
    expect(opened).toBe(true);
  });
});
