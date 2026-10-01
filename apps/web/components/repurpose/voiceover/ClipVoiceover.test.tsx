import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepurposeVoiceover, RepurposeVoiceoverList } from "@montaj/api-client";

import { ClipVoiceoverView } from "./ClipVoiceover";
import { allVoiceoverSentences, voiceoverFailureCopy } from "./copy";
import { beginnerSafetyViolations } from "../copy";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JCRN0000000000000000000A";
const CLIP = "01JCC11P00000000000000000A";
const VO = "01JCDVC0000000000000000000";
const CREATE_ROUTE = `/repurpose/runs/${RUN}/clips/${CLIP}/voiceovers`;
const RETRY_ROUTE = `/repurpose/runs/${RUN}/voiceovers/${VO}/retry`;

function list(overrides: Partial<RepurposeVoiceoverList> = {}): RepurposeVoiceoverList {
  return {
    runId: RUN,
    enabled: true,
    tenthsPerVoiceover: 20,
    maxTextChars: 300,
    speakers: [
      { id: "anushka", name: "Anushka (female)" },
      { id: "karun", name: "Karun (male)" },
    ],
    clips: [
      {
        clipId: CLIP,
        ready: true,
        text: "Nobody tells you this",
        language: { code: "en-IN", name: "English" },
        voiceoverId: null,
      },
    ],
    voiceovers: [],
    ...overrides,
  };
}

function voiceover(overrides: Partial<RepurposeVoiceover> = {}): RepurposeVoiceover {
  return {
    id: VO,
    runId: RUN,
    clipId: CLIP,
    status: "speaking",
    failureCode: null,
    failureMessage: null,
    text: "Nobody tells you this",
    language: { code: "en-IN", name: "English" },
    speaker: { id: "anushka", name: "Anushka (female)" },
    durationMs: null,
    costTenths: 20,
    audioUrl: null,
    placedShapes: 0,
    canRetry: false,
    canRemove: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function callTo(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  route: string,
): RequestInit | undefined {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(route));
  return call?.[1] as RequestInit | undefined;
}

describe("<ClipVoiceoverView /> (2026-10-01)", () => {
  it("shows nothing while voice-overs are switched off and the clip has none", () => {
    const { container } = renderWithProviders(
      <ClipVoiceoverView runId={RUN} clipId={CLIP} title="T" list={list({ enabled: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing for a clip whose language the voice does not speak", () => {
    const { container } = renderWithProviders(
      <ClipVoiceoverView
        runId={RUN}
        clipId={CLIP}
        title="T"
        list={list({
          clips: [{ clipId: CLIP, ready: true, text: "x", language: null, voiceoverId: null }],
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("opens on the clip's hook, says the cost, and sends only what changed", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipVoiceoverView runId={RUN} clipId={CLIP} title="The money bit" list={list()} />,
      { routes: { [CREATE_ROUTE]: voiceover() } },
    );
    fireEvent.click(screen.getByTestId(`voiceover-add-${CLIP}`));
    const dialog = screen.getByTestId(`voiceover-dialog-${CLIP}`);
    expect(within(dialog).getByTestId("voiceover-text")).toHaveValue("Nobody tells you this");
    expect(within(dialog).getByTestId("voiceover-cost")).toHaveTextContent("Costs 2 credits.");
    expect(dialog).toHaveTextContent("in English");

    fireEvent.change(within(dialog).getByTestId("voiceover-speaker"), {
      target: { value: "karun" },
    });
    fireEvent.click(within(dialog).getByTestId("voiceover-confirm"));
    await waitFor(() => {
      expect(callTo(fetchMock, CREATE_ROUTE)).toBeDefined();
    });
    expect(JSON.parse(String(callTo(fetchMock, CREATE_ROUTE)?.body))).toEqual({
      speaker: "karun",
    });
  });

  it("sends the person's own line when they change it, and waits for words", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipVoiceoverView runId={RUN} clipId={CLIP} title="T" list={list()} />,
      { routes: { [CREATE_ROUTE]: voiceover() } },
    );
    fireEvent.click(screen.getByTestId(`voiceover-add-${CLIP}`));
    const dialog = screen.getByTestId(`voiceover-dialog-${CLIP}`);
    const text = within(dialog).getByTestId("voiceover-text");
    fireEvent.change(text, { target: { value: " " } });
    expect(within(dialog).getByTestId("voiceover-confirm")).toBeDisabled();
    fireEvent.change(text, { target: { value: "Wait   for it" } });
    fireEvent.click(within(dialog).getByTestId("voiceover-confirm"));
    await waitFor(() => {
      expect(callTo(fetchMock, CREATE_ROUTE)).toBeDefined();
    });
    expect(JSON.parse(String(callTo(fetchMock, CREATE_ROUTE)?.body))).toEqual({
      text: "Wait for it",
      speaker: "anushka",
    });
  });

  it("says a refusal in its own words", async () => {
    renderWithProviders(<ClipVoiceoverView runId={RUN} clipId={CLIP} title="T" list={list()} />, {
      routes: {
        [CREATE_ROUTE]: new Response(
          JSON.stringify({ error: { code: "voiceover/no_credits", message: "no" } }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
      },
    });
    fireEvent.click(screen.getByTestId(`voiceover-add-${CLIP}`));
    fireEvent.click(screen.getByTestId("voiceover-confirm"));
    expect(await screen.findByTestId("voiceover-error")).toHaveTextContent(
      "There are not enough credits for a voice-over.",
    );
  });

  it("shows a made voice-over with a player and where it is, and no second Add", () => {
    renderWithProviders(
      <ClipVoiceoverView
        runId={RUN}
        clipId={CLIP}
        title="The money bit"
        list={list({
          voiceovers: [
            voiceover({
              status: "ready",
              audioUrl: "https://media.test/hook.wav",
              placedShapes: 4,
              durationMs: 2_400,
            }),
          ],
        })}
      />,
    );
    expect(screen.queryByTestId(`voiceover-add-${CLIP}`)).toBeNull();
    expect(screen.getByTestId(`voiceover-status-${VO}`)).toHaveTextContent("Added");
    expect(screen.getByTestId(`voiceover-player-${VO}`)).toHaveAttribute(
      "src",
      "https://media.test/hook.wav",
    );
    expect(screen.getByTestId(`voiceover-placed-${VO}`)).toHaveTextContent(
      "On 4 sizes of this clip",
    );
  });

  it("explains a failure and tries again", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipVoiceoverView
        runId={RUN}
        clipId={CLIP}
        title="T"
        list={list({
          voiceovers: [
            voiceover({
              status: "failed",
              failureCode: "voiceover/vendor_unavailable",
              canRetry: true,
            }),
          ],
        })}
      />,
      { routes: { [RETRY_ROUTE]: voiceover() } },
    );
    expect(screen.getByTestId(`voiceover-failure-${VO}`)).toHaveTextContent(
      "Something went wrong. Try again.",
    );
    fireEvent.click(screen.getByTestId(`voiceover-retry-${VO}`));
    await waitFor(() => {
      expect(callTo(fetchMock, RETRY_ROUTE)).toBeDefined();
    });
  });

  it("keeps a clip's voice-over visible after the switch goes off, so it can be taken off", () => {
    renderWithProviders(
      <ClipVoiceoverView
        runId={RUN}
        clipId={CLIP}
        title="T"
        list={list({ enabled: false, voiceovers: [voiceover({ status: "ready" })] })}
      />,
    );
    expect(screen.getByTestId(`voiceover-remove-${VO}`)).toBeInTheDocument();
  });
});

describe("voice-over copy", () => {
  it("uses plain words", () => {
    for (const sentence of [...allVoiceoverSentences(), voiceoverFailureCopy("x", null)]) {
      expect(beginnerSafetyViolations(sentence), sentence).toEqual([]);
    }
  });

  it("shows the vendor's own words only for its refusal", () => {
    expect(voiceoverFailureCopy("voiceover/vendor_refused", "bad character")).toContain(
      "(bad character)",
    );
    expect(voiceoverFailureCopy("voiceover/vendor_auth", "key=abc")).not.toContain("key");
  });
});
