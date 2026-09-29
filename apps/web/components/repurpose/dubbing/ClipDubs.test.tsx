import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  RepurposeDub,
  RepurposeDubFormat,
  RepurposeDubLanguageView,
  RepurposeDubList,
} from "@montaj/api-client";

import { ClipDubs } from "./ClipDubs";
import { allDubSentences, creditsText, dubFailureCopy } from "./copy";
import { CandidateCard } from "../CandidateCard";
import { REFUSAL_COPY, beginnerSafetyViolations } from "../copy";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JCRN0000000000000000000A";
const CLIP = "01JCC11P00000000000000000A";
const DUB = "01JCDVB0000000000000000000";
const PROJECT = "01JCPR0JECT000000000000000";
const CREATE_ROUTE = `/repurpose/runs/${RUN}/clips/${CLIP}/dubs`;
const RETRY_ROUTE = `/repurpose/runs/${RUN}/dubs/${DUB}/retry`;
const CANCEL_ROUTE = `/repurpose/runs/${RUN}/dubs/${DUB}/cancel`;

const LANGUAGES: RepurposeDubList["languages"] = [
  { code: "en-IN", name: "English" },
  { code: "hi-IN", name: "Hindi" },
  { code: "bn-IN", name: "Bengali" },
  { code: "ta-IN", name: "Tamil" },
];

function list(overrides: Partial<RepurposeDubList> = {}): RepurposeDubList {
  return {
    runId: RUN,
    enabled: true,
    tenthsPerMinute: 250,
    languages: LANGUAGES,
    clips: [
      {
        clipId: CLIP,
        ready: true,
        sourceLanguage: { code: "en-IN", name: "English" },
        durationMs: 34_000,
        taken: [],
      },
    ],
    dubs: [],
    ...overrides,
  };
}

function format(overrides: Partial<RepurposeDubFormat> = {}): RepurposeDubFormat {
  return {
    shape: "9:16",
    status: "ready",
    projectId: PROJECT,
    captioned: {
      status: "ready",
      playUrl: "https://media.test/dubs/hi/9x16.mp4?X-Amz-Expires=3600",
      downloadUrl: "https://media.test/dubs/hi/9x16.mp4?download=1",
    },
    cleanUrl: "https://media.test/dubs/hi/9x16-clean.mp4",
    ...overrides,
  };
}

function language(overrides: Partial<RepurposeDubLanguageView> = {}): RepurposeDubLanguageView {
  return {
    code: "hi-IN",
    name: "Hindi",
    status: "dubbing",
    reason: null,
    formats: [],
    ...overrides,
  };
}

function dub(overrides: Partial<RepurposeDub> = {}): RepurposeDub {
  return {
    id: DUB,
    runId: RUN,
    clipId: CLIP,
    status: "dubbing",
    failureCode: null,
    failureMessage: null,
    sourceLanguage: { code: "en-IN", name: "English" },
    languages: [language()],
    durationMs: 34_000,
    costTenths: 142,
    progress: null,
    step: null,
    canRetry: false,
    canCancel: false,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: "refused" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function callTo(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  route: string,
): RequestInit | undefined {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith(route));
  return call?.[1] as RequestInit | undefined;
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByTestId(`dub-clip-${CLIP}`));
  return screen.getByTestId(`dub-dialog-${CLIP}`);
}

describe("<ClipDubs /> — the Dub dialog (2026-10-04)", () => {
  it("offers every language but the clip's own, with the ones already dubbed shown and locked", () => {
    renderWithProviders(
      <ClipDubs
        runId={RUN}
        clipId={CLIP}
        title="The money bit"
        list={list({
          clips: [
            {
              clipId: CLIP,
              ready: true,
              sourceLanguage: { code: "en-IN", name: "English" },
              durationMs: 34_000,
              taken: ["ta-IN"],
            },
          ],
        })}
      />,
    );
    const dialog = openDialog();
    expect(within(dialog).queryByTestId("dub-language-en-IN")).toBeNull();
    expect(within(dialog).getByTestId("dub-language-hi-IN")).toBeEnabled();
    expect(within(dialog).getByTestId("dub-language-bn-IN")).toBeEnabled();
    const taken = within(dialog).getByTestId("dub-language-ta-IN");
    expect(taken).toBeDisabled();
    expect(taken).toBeChecked();
    expect(within(dialog).getByText("Tamil")).toHaveTextContent("Tamil (already dubbed)");
    expect(dialog).toHaveTextContent("It is spoken in English.");
  });

  it("says what it costs, the API's own sum, and waits for a language and the voice tick", () => {
    renderWithProviders(<ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list()} />);
    const dialog = openDialog();
    const confirm = within(dialog).getByTestId("dub-confirm");
    expect(within(dialog).getByTestId("dub-cost")).toHaveTextContent(
      "Pick the languages to dub into.",
    );
    expect(confirm).toBeDisabled();

    // 34 s at 25 credits a minute: 14.17, held as 14.2.
    fireEvent.click(within(dialog).getByTestId("dub-language-hi-IN"));
    expect(within(dialog).getByTestId("dub-cost")).toHaveTextContent(
      "Costs 14.2 credits (25 credits a minute for each language).",
    );
    fireEvent.click(within(dialog).getByTestId("dub-language-bn-IN"));
    expect(within(dialog).getByTestId("dub-cost")).toHaveTextContent("Costs 28.4 credits");
    expect(confirm).toHaveTextContent("Dub into 2 languages");
    // No language is dubbed without the speaker's voice being cleared.
    expect(confirm).toBeDisabled();
    const consent = within(dialog).getByTestId("dub-consent");
    expect(consent).not.toBeChecked();
    expect(within(dialog).getByLabelText(/consent to it being cloned/)).toBe(consent);
    fireEvent.click(consent);
    expect(confirm).toBeEnabled();

    // Unpicking every language turns it off again.
    fireEvent.click(within(dialog).getByTestId("dub-language-hi-IN"));
    fireEvent.click(within(dialog).getByTestId("dub-language-bn-IN"));
    expect(confirm).toBeDisabled();
  });

  it("asks for the dub with the languages picked and the tick, then closes", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list()} />,
      { routes: { [CREATE_ROUTE]: dub({ status: "waiting" }) } },
    );
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId("dub-language-hi-IN"));
    fireEvent.click(within(dialog).getByTestId("dub-language-bn-IN"));
    fireEvent.click(within(dialog).getByTestId("dub-consent"));
    fireEvent.click(within(dialog).getByTestId("dub-confirm"));

    await waitFor(() => {
      expect(screen.queryByTestId(`dub-dialog-${CLIP}`)).toBeNull();
    });
    const init = callTo(fetchMock, CREATE_ROUTE);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      languages: ["hi-IN", "bn-IN"],
      consent: true,
    });
  });

  it("says why a dub was refused, in the page's words", async () => {
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list()} />,
      { routes: { [CREATE_ROUTE]: refused(402, "dub/no_credits") } },
    );
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByTestId("dub-language-hi-IN"));
    fireEvent.click(within(dialog).getByTestId("dub-consent"));
    fireEvent.click(within(dialog).getByTestId("dub-confirm"));
    expect(await screen.findByTestId("dub-error")).toHaveTextContent(
      "You do not have enough credits for this dub.",
    );
    // The dialog stays, with what was picked, so fewer languages can be tried.
    expect(within(dialog).getByTestId("dub-language-hi-IN")).toBeChecked();
  });

  it("shows nothing while dubbing is off and the clip has no dubs, nor for a clip it cannot dub", () => {
    const off = renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ enabled: false })} />,
    );
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();

    const unsupported = list({
      clips: [{ clipId: CLIP, ready: true, sourceLanguage: null, durationMs: 34_000, taken: [] }],
    });
    const { container } = renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={unsupported} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers no new dub on a stopped run or a clip being cut again, but keeps its languages", () => {
    renderWithProviders(
      <ClipDubs
        runId={RUN}
        clipId={CLIP}
        title="The money bit"
        list={list({ dubs: [dub()] })}
        offerDub={false}
      />,
    );
    expect(screen.queryByTestId(`dub-clip-${CLIP}`)).toBeNull();
    expect(screen.getByTestId(`clip-languages-${CLIP}`)).toBeInTheDocument();
  });
});

describe("<ClipDubs /> — a clip's languages (2026-10-04)", () => {
  it("says where each language stands, with the service's percent and step while it dubs", () => {
    const dubs = [
      dub({ progress: 40, step: "Cloning the voice" }),
      dub({
        id: "01JCDVB0000000000000000001",
        status: "waiting",
        languages: [language({ code: "bn-IN", name: "Bengali", status: "queued" })],
      }),
      dub({
        id: "01JCDVB0000000000000000002",
        status: "making",
        languages: [
          language({
            code: "ta-IN",
            name: "Tamil",
            status: "making",
            formats: [format({ status: "preparing", captioned: null, cleanUrl: null })],
          }),
        ],
      }),
    ];
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs })} />,
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-hi-IN`)).toHaveTextContent(
      "Dubbing 40% · Cloning the voice",
    );
    expect(
      screen.getByTestId("dub-language-status-01JCDVB0000000000000000001-bn-IN"),
    ).toHaveTextContent("Waiting for a free slot");
    expect(
      screen.getByTestId("dub-language-status-01JCDVB0000000000000000002-ta-IN"),
    ).toHaveTextContent("Making the videos");
    expect(
      screen.getByTestId("dub-format-01JCDVB0000000000000000002-ta-IN-9x16"),
    ).toHaveTextContent("Vertical 9:16 · Being made…");
    expect(screen.getByTestId(`clip-languages-${CLIP}`)).toHaveTextContent("0 of 3 ready");
  });

  it("plays a ready language's captioned 9:16 video and offers each shape's files and editor", () => {
    const ready = dub({
      status: "ready",
      languages: [
        language({
          status: "ready",
          formats: [
            format(),
            format({
              shape: "4:5",
              projectId: "01JCPR0JECT000000000000001",
              captioned: {
                status: "ready",
                playUrl: "https://media.test/dubs/hi/4x5.mp4",
                downloadUrl: "https://media.test/dubs/hi/4x5.mp4?download=1",
              },
              cleanUrl: "https://media.test/dubs/hi/4x5-clean.mp4",
            }),
            format({ shape: "1:1", status: "failed", captioned: null, cleanUrl: null }),
          ],
        }),
      ],
    });
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [ready] })} />,
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-hi-IN`)).toHaveTextContent("Ready");
    expect(screen.getByTestId(`dub-video-${DUB}-hi-IN`)).toHaveAttribute(
      "src",
      "https://media.test/dubs/hi/9x16.mp4?X-Amz-Expires=3600",
    );
    expect(screen.getByLabelText("The money bit, dubbed in Hindi, 9:16 with captions")).toBe(
      screen.getByTestId(`dub-video-${DUB}-hi-IN`),
    );

    const vertical = screen.getByTestId(`dub-format-${DUB}-hi-IN-9x16`);
    expect(within(vertical).getByRole("link", { name: /^Download Vertical 9:16/ })).toHaveAttribute(
      "href",
      "https://media.test/dubs/hi/9x16.mp4?download=1",
    );
    expect(within(vertical).getByText("Without captions")).toHaveAttribute(
      "href",
      "https://media.test/dubs/hi/9x16-clean.mp4",
    );
    expect(within(vertical).getByText("Edit")).toHaveAttribute("href", `/p/${PROJECT}`);

    const portrait = screen.getByTestId(`dub-format-${DUB}-hi-IN-4x5`);
    expect(within(portrait).getByText("Edit")).toHaveAttribute(
      "href",
      "/p/01JCPR0JECT000000000000001",
    );
    expect(screen.getByTestId(`dub-format-${DUB}-hi-IN-1x1`)).toHaveTextContent(
      "Square 1:1 · Could not be made.",
    );
    expect(screen.getByTestId(`clip-languages-${CLIP}`)).toHaveTextContent("1 of 1 ready");
  });

  it("says once why a whole dub failed, with the service's own words, and offers no Retry it refused", () => {
    const failed = dub({
      status: "failed",
      failureCode: "dub/vendor_refused",
      failureMessage: "Audio has no speech",
      languages: [
        language({ status: "failed", reason: "Audio has no speech" }),
        language({
          code: "bn-IN",
          name: "Bengali",
          status: "failed",
          reason: "Audio has no speech",
        }),
      ],
    });
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [failed] })} />,
    );
    expect(screen.getByTestId(`dub-failure-${DUB}`)).toHaveTextContent(
      "The dubbing service could not dub this clip. “Audio has no speech”",
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-hi-IN`)).toHaveTextContent(
      /^Could not be dubbed$/,
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-bn-IN`)).toHaveTextContent(
      /^Could not be dubbed$/,
    );
    expect(screen.queryByTestId(`dub-retry-${DUB}`)).toBeNull();
    expect(screen.queryByTestId(`dub-stop-${DUB}`)).toBeNull();
  });

  it("names the service's reason for one language of a dub that was made", () => {
    const partly = dub({
      status: "ready",
      languages: [
        language({ status: "ready", formats: [format()] }),
        language({
          code: "ta-IN",
          name: "Tamil",
          status: "failed",
          reason: "The dubbing service did not dub this language.",
        }),
      ],
    });
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [partly] })} />,
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-ta-IN`)).toHaveTextContent(
      "Could not be dubbed: The dubbing service did not dub this language.",
    );
    expect(screen.queryByTestId(`dub-failure-${DUB}`)).toBeNull();
  });

  it("tries a failed dub again", async () => {
    const failed = dub({
      status: "failed",
      failureCode: "dub/vendor_timeout",
      canRetry: true,
      languages: [language({ status: "failed" })],
    });
    const { fetchMock } = renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [failed] })} />,
      { routes: { [RETRY_ROUTE]: dub({ status: "dubbing" }) } },
    );
    expect(screen.getByTestId(`dub-failure-${DUB}`)).toHaveTextContent(
      "Try again to pick it up where it is, at no extra cost.",
    );
    fireEvent.click(screen.getByTestId(`dub-retry-${DUB}`));
    await waitFor(() => {
      expect(callTo(fetchMock, RETRY_ROUTE)?.method).toBe("POST");
    });
  });

  it("stops a dub only once the person confirms it", async () => {
    const live = dub({ canCancel: true, progress: 12, step: null });
    const { fetchMock } = renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [live] })} />,
      { routes: { [CANCEL_ROUTE]: dub({ status: "cancelled" }) } },
    );
    expect(screen.getByTestId(`dub-language-status-${DUB}-hi-IN`)).toHaveTextContent(
      /^Dubbing 12%$/,
    );
    fireEvent.click(screen.getByTestId(`dub-stop-${DUB}`));
    const confirm = await screen.findByTestId("confirm-action-dialog");
    expect(confirm).toHaveTextContent("Stop this dub?");
    expect(callTo(fetchMock, CANCEL_ROUTE)).toBeUndefined();
    // Cancel is focused first (`ConfirmAction`); the named button stops it.
    fireEvent.click(screen.getByTestId(`dub-stop-confirm-${DUB}`));
    await waitFor(() => {
      expect(callTo(fetchMock, CANCEL_ROUTE)?.method).toBe("POST");
    });
  });

  it("says why a Stop was refused", async () => {
    const live = dub({ canCancel: true });
    renderWithProviders(
      <ClipDubs runId={RUN} clipId={CLIP} title="The money bit" list={list({ dubs: [live] })} />,
      { routes: { [CANCEL_ROUTE]: refused(409, "dub/not_cancellable") } },
    );
    fireEvent.click(screen.getByTestId(`dub-stop-${DUB}`));
    fireEvent.click(await screen.findByTestId(`dub-stop-confirm-${DUB}`));
    expect(await screen.findByTestId(`dub-error-${DUB}`)).toHaveTextContent(
      "The dub has already been made, so it cannot be stopped now.",
    );
  });
});

describe("<CandidateCard /> with dubs (2026-10-04)", () => {
  const CAND = "01JCCAND000000000000000000";
  const candidate = {
    id: CAND,
    startMs: 60_000,
    endMs: 94_000,
    title: "The money bit",
    potentialScore: 80,
  };

  it("offers Dub on a ready clip's card", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate}
          clip={{ id: CLIP, candidateId: CAND, state: "ready" }}
          previewActive={false}
          onActivatePreview={() => undefined}
          dubs={list()}
        />
      </ul>,
    );
    const card = screen.getByTestId(`candidate-card-${CAND}`);
    expect(within(card).getByTestId(`dub-clip-${CLIP}`)).toHaveAccessibleName("Dub: The money bit");
  });

  it("keeps a clip's languages while it is cut again, and offers no new dub until it is ready", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate}
          clip={{ id: CLIP, candidateId: CAND, state: "cutting" }}
          previewActive={false}
          onActivatePreview={() => undefined}
          dubs={list({ dubs: [dub()] })}
        />
      </ul>,
    );
    const card = screen.getByTestId(`candidate-card-${CAND}`);
    expect(within(card).queryByTestId(`dub-clip-${CLIP}`)).toBeNull();
    expect(within(card).getByTestId(`clip-languages-${CLIP}`)).toBeInTheDocument();
  });

  it("shows no dubbing on a card while the run's dubs are still loading", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate}
          clip={{ id: CLIP, candidateId: CAND, state: "ready" }}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );
    expect(screen.queryByTestId(`clip-dubs-${CLIP}`)).toBeNull();
  });
});

describe("dubbing copy (2026-10-04)", () => {
  it("never names the tools behind it, nor the dubbing service", () => {
    const everything = [...allDubSentences(), ...Object.values(REFUSAL_COPY.dub)];
    for (const text of everything) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
      expect(text.toLowerCase(), text).not.toContain("sarvam");
    }
  });

  it("has a sentence for every refusal the API names", () => {
    const refusals = [
      "dub/not_enabled",
      "dub/not_found",
      "dub/clip_not_ready",
      "dub/clip_removed",
      "dub/run_stopped",
      "dub/consent_required",
      "dub/source_unsupported",
      "dub/same_language",
      "dub/language_taken",
      "dub/too_many",
      "dub/budget_reached",
      "dub/budget_unavailable",
      "dub/no_credits",
      "dub/plan_limit",
      "dub/too_long",
      "dub/not_retryable",
      "dub/not_cancellable",
    ];
    for (const code of refusals) expect(Object.keys(REFUSAL_COPY.dub)).toContain(code);
  });

  it("reads tenths of a credit as a person does", () => {
    expect(creditsText(284)).toBe("28.4");
    expect(creditsText(250)).toBe("25");
    expect(creditsText(100)).toBe("10");
    expect(creditsText(-5)).toBe("0");
  });

  it("adds the service's words to a failure only when it gave some", () => {
    expect(dubFailureCopy("dub/vendor_failed", "  Voice unusable ")).toBe(
      "The dub did not work. “Voice unusable”",
    );
    expect(dubFailureCopy("dub/vendor_failed", " ")).toBe("The dub did not work.");
    expect(dubFailureCopy("jobs/whatever", null)).toBe(
      "The dub stopped part way. Try again to carry on.",
    );
    expect(dubFailureCopy(null, null)).toBe("The dub stopped part way. Try again to carry on.");
  });
});
