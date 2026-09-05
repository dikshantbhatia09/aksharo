import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { RetranscribeDialog } from "./RetranscribeDialog";

import { renderWithProviders } from "@/test/harness";

const PROJECT = "01JPROJECT0000000000000000";
const ROUTE = `/projects/${PROJECT}/transcript/retranscribe`;

const ACCEPTED = {
  jobId: "01JJOB0000000000000000000A",
  transcriptId: "01JT",
  status: "queued",
  deduplicated: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const hasEdits = (): Response =>
  json(
    {
      error: {
        code: "transcript/has_edits",
        message: "The editing document has moved past the first transcription.",
      },
    },
    409,
  );

function bodyOf(fetchMock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const calls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/retranscribe"));
  const call = calls.at(index);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

beforeEach(() => {
  localStorage.clear();
});

describe("<RetranscribeDialog />", () => {
  it("opens on the project's current language and quotes the edits rule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />);

    await user.click(screen.getByTestId("retranscribe-open"));

    expect(await screen.findByTestId("retranscribe-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("quick-pick-language-hi")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("retranscribe-warning")).toHaveTextContent(
      "Re-transcribing replaces every word id. Captions you have retimed, split or retyped will lose those edits.",
    );
  });

  it("sends the newly chosen language, without force", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      { routes: { [ROUTE]: ACCEPTED } },
    );

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(await screen.findByTestId("quick-pick-language-en"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    await waitFor(() => {
      expect(bodyOf(fetchMock)).toMatchObject({ languages: ["en"], force: false });
    });
  });

  // The documented 409: the server refuses, so the dialog asks a second,
  // differently-worded question rather than forcing on the user's behalf.
  it("asks again on transcript/has_edits, then completes with force", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      {
        routes: {
          [ROUTE]: ACCEPTED,
        },
      },
    );
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (!String(input).endsWith("/retranscribe")) return Promise.resolve(json({}, 404));
      attempt += 1;
      return Promise.resolve(attempt === 1 ? hasEdits() : json(ACCEPTED));
    });

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(await screen.findByTestId("quick-pick-language-en"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    // Refused, and said so — no silent force.
    expect(await screen.findByTestId("retranscribe-has-edits")).toHaveTextContent(
      "Continuing discards them",
    );
    expect(bodyOf(fetchMock, 0)).toMatchObject({ force: false });

    await user.click(screen.getByTestId("retranscribe-force"));

    await waitFor(() => {
      expect(bodyOf(fetchMock, 1)).toMatchObject({ languages: ["en"], force: true });
    });
    // Accepted, so the dialog closes; the editor keeps the old document until
    // FIX-03's pipeline announces the new one.
    await waitFor(() => {
      expect(screen.queryByTestId("retranscribe-dialog")).toBeNull();
    });
  });

  it("stays open and sends nothing more when the retry is refused too", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <RetranscribeDialog projectId={PROJECT} sourceLanguage="hi" />,
      { routes: { [ROUTE]: hasEdits() } },
    );
    fetchMock.mockImplementation(() => Promise.resolve(hasEdits()));

    await user.click(screen.getByTestId("retranscribe-open"));
    await user.click(screen.getByTestId("retranscribe-confirm"));

    expect(await screen.findByTestId("retranscribe-has-edits")).toBeInTheDocument();
    expect(screen.getByTestId("retranscribe-dialog")).toBeInTheDocument();
  });
});
