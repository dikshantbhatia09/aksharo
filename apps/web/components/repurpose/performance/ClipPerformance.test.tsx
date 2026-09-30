import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { RepurposeCandidateItem } from "@montaj/api-client";

import { ClipPerformance } from "./ClipPerformance";
import { allPerformanceSentences } from "./copy";
import { CandidateCard } from "../CandidateCard";
import { beginnerSafetyViolations } from "../copy";

import type { ClipPost, RunPerformance } from "./use-performance";

import { renderWithProviders, testAccessToken } from "@/test/harness";

/**
 * How a clip did, on its card (2026-10-05): its posts and their numbers, where
 * each number came from, "I posted this", typing numbers in and removing a
 * pasted link - and nothing at all while the feature is off.
 */
const RUN = "01JPWRUN000000000000000000";
const CLIP = "01JPWC11P00000000000000000";
const POST = "01JPWP0ST00000000000000000";
const ENTITLEMENT = "/workspaces/01JWORKSPACE/entitlement";
const PERFORMANCE = `/repurpose/runs/${RUN}/performance`;
const ADD = `/repurpose/runs/${RUN}/clips/${CLIP}/performance/posts`;
const NUMBERS = `/repurpose/runs/${RUN}/performance/posts/${POST}/numbers`;
const REMOVE = `/repurpose/runs/${RUN}/performance/posts/${POST}`;
const HOUR = 60 * 60_000;

function entitlement(flags: Record<string, boolean>): Record<string, unknown> {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 200,
    seatsIncluded: 1,
    seatsUsed: 1,
    computedAt: "2026-10-05T10:00:00.000Z",
    entitlements: { flags },
  };
}

function post(overrides: Partial<ClipPost> = {}): ClipPost {
  const measuredAt = new Date(Date.now() - 2 * HOUR).toISOString();
  const enteredAt = new Date(Date.now() - 3 * 24 * HOUR).toISOString();
  return {
    id: POST,
    runId: RUN,
    clipId: CLIP,
    platform: "youtube",
    platformLabel: "YouTube",
    shape: "9:16",
    language: null,
    source: "link",
    url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    postedAt: "2026-10-03T12:00:00.000Z",
    numbers: {
      views: { value: 12_400, source: "youtube_page", measured: true, at: measuredAt },
      likes: { value: 830, source: "person", measured: false, at: enteredAt },
      comments: { value: 41, source: "person", measured: false, at: enteredAt },
      shares: null,
    },
    engagementRate: 0.07,
    reading: {
      state: "reading",
      nextAt: new Date(Date.now() + 4 * HOUR).toISOString(),
      note: null,
    },
    canRemove: true,
    createdAt: "2026-10-03T12:00:00.000Z",
    ...overrides,
  };
}

function performance(posts: ClipPost[] = [post()]): RunPerformance {
  return {
    runId: RUN,
    enabled: true,
    readsEnabled: true,
    posts,
    clips: [{ clipId: CLIP, shapes: ["9:16", "1:1"], languages: ["hi-IN"] }],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (body: unknown) => Response;

/** Answers by method and path; the harness's table answers the rest. */
function serve(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  handlers: Record<string, Handler>,
): { calls: { key: string; body: unknown }[] } {
  const calls: { key: string; body: unknown }[] = [];
  const through = fetchMock.getMockImplementation() as (
    input: RequestInfo | URL,
  ) => Promise<Response>;
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`;
    // eslint-disable-next-line security/detect-object-injection -- a test's own table
    const handler = handlers[key];
    if (handler === undefined) return through(input);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    calls.push({ key, body });
    return Promise.resolve(handler(body));
  });
  return { calls };
}

function render(
  options: {
    readonly flags?: Record<string, boolean>;
    readonly body?: RunPerformance;
    readonly role?: string;
    readonly ready?: boolean;
  } = {},
) {
  return renderWithProviders(
    <ClipPerformance
      runId={RUN}
      clipId={CLIP}
      title="The money bit"
      ready={options.ready ?? true}
    />,
    {
      routes: {
        [ENTITLEMENT]: entitlement(options.flags ?? { repurpose_performance: true }),
        [PERFORMANCE]: options.body ?? performance(),
      },
      accessToken: testAccessToken({ role: options.role ?? "editor" }),
    },
  );
}

describe("<ClipPerformance />", () => {
  it("shows nothing, and asks nothing, while the feature is off", async () => {
    const { fetchMock } = render({ flags: {} });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === ENTITLEMENT),
      ).toBe(true);
    });
    expect(screen.queryByTestId(`clip-performance-${CLIP}`)).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) => new URL(String(input)).pathname === PERFORMANCE),
    ).toBe(false);
  });

  it("shows each post's numbers and says which were measured and which entered", async () => {
    render();
    const row = await screen.findByTestId(`performance-post-${POST}`);
    expect(within(row).getByTestId(`performance-numbers-${POST}`)).toHaveTextContent(
      "12.4k views · 830 likes · 41 comments · 7.0% engagement",
    );
    expect(within(row).getByTestId(`performance-sources-${POST}`)).toHaveTextContent(
      "Views measured from YouTube 2 h ago · likes and comments entered 3 days ago.",
    );
    expect(within(row).getByTestId(`performance-reading-${POST}`)).toHaveTextContent(
      "Read again in 4 h.",
    );
    expect(within(row).getByTestId(`performance-link-${POST}`)).toHaveAttribute(
      "href",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    );
    expect(screen.getByTestId(`clip-performance-${CLIP}`)).toHaveTextContent(
      "1 post · 12.4k views",
    );
  });

  it("says so when this server reads no numbers by itself", async () => {
    render({ body: { ...performance(), readsEnabled: false } });
    expect(await screen.findByTestId(`performance-reading-${POST}`)).toHaveTextContent(
      "Numbers are not read by themselves right now: type them in when you check.",
    );
  });

  it("says a platform it cannot read is typed in by hand", async () => {
    render({
      body: performance([
        post({
          platform: "instagram",
          platformLabel: "Instagram",
          url: null,
          numbers: { views: null, likes: null, comments: null, shares: null },
          engagementRate: null,
          reading: {
            state: "manual",
            nextAt: null,
            note: "Aksharo cannot read Instagram numbers by itself: type them in when you check.",
          },
        }),
      ]),
    });
    const row = await screen.findByTestId(`performance-post-${POST}`);
    expect(row).toHaveTextContent("No numbers yet.");
    expect(within(row).getByTestId(`performance-reading-${POST}`)).toHaveTextContent(
      "Aksharo cannot read Instagram numbers by itself",
    );
    expect(within(row).queryByTestId(`performance-link-${POST}`)).toBeNull();
  });

  it("adds a post by its link, in the shape and language chosen", async () => {
    const { fetchMock } = render({ body: performance([]) });
    const { calls } = serve(fetchMock, { [`POST ${ADD}`]: () => json(201, post()) });

    fireEvent.click(await screen.findByTestId(`add-post-${CLIP}`));
    fireEvent.change(screen.getByTestId(`add-post-url-${CLIP}`), {
      target: { value: " https://youtube.com/shorts/dQw4w9WgXcQ " },
    });
    fireEvent.change(screen.getByTestId(`add-post-shape-${CLIP}`), { target: { value: "1:1" } });
    fireEvent.change(screen.getByTestId(`add-post-language-${CLIP}`), {
      target: { value: "hi-IN" },
    });
    fireEvent.change(screen.getByTestId(`add-post-date-${CLIP}`), {
      target: { value: "2026-10-04" },
    });
    fireEvent.click(screen.getByTestId(`add-post-save-${CLIP}`));

    await waitFor(() => {
      expect(calls).toEqual([
        {
          key: `POST ${ADD}`,
          body: {
            url: "https://youtube.com/shorts/dQw4w9WgXcQ",
            shape: "1:1",
            language: "hi-IN",
            postedAt: "2026-10-04",
          },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`add-post-form-${CLIP}`)).toBeNull();
    });
  });

  it("says why a link was refused, in words a person can act on", async () => {
    const { fetchMock } = render({ body: performance([]) });
    serve(fetchMock, {
      [`POST ${ADD}`]: () =>
        json(400, { error: { code: "performance/link_short", message: "raw server words" } }),
    });
    fireEvent.click(await screen.findByTestId(`add-post-${CLIP}`));
    fireEvent.click(screen.getByTestId(`add-post-save-${CLIP}`));
    expect(await screen.findByTestId(`add-post-error-${CLIP}`)).toHaveTextContent(
      "Paste the link to the post.",
    );
    fireEvent.change(screen.getByTestId(`add-post-url-${CLIP}`), {
      target: { value: "https://vm.tiktok.com/abc" },
    });
    fireEvent.click(screen.getByTestId(`add-post-save-${CLIP}`));
    await waitFor(() => {
      expect(screen.getByTestId(`add-post-error-${CLIP}`)).toHaveTextContent(
        "That is a short link. Open it, then copy the full address of the post.",
      );
    });
    expect(screen.getByTestId(`add-post-error-${CLIP}`)).not.toHaveTextContent("raw server words");
  });

  it("types numbers in, checking them first", async () => {
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, { [`POST ${NUMBERS}`]: () => json(200, post()) });
    fireEvent.click(await screen.findByTestId(`numbers-open-${POST}`));
    // The entered numbers come back to be changed; the measured one does not.
    expect(screen.getByTestId(`numbers-views-${POST}`)).toHaveValue("");
    expect(screen.getByTestId(`numbers-likes-${POST}`)).toHaveValue("830");

    fireEvent.change(screen.getByTestId(`numbers-likes-${POST}`), { target: { value: "" } });
    fireEvent.change(screen.getByTestId(`numbers-comments-${POST}`), { target: { value: "" } });
    fireEvent.click(screen.getByTestId(`numbers-save-${POST}`));
    expect(await screen.findByTestId(`numbers-error-${POST}`)).toHaveTextContent(
      "Type at least one number.",
    );
    fireEvent.change(screen.getByTestId(`numbers-shares-${POST}`), { target: { value: "-4" } });
    fireEvent.click(screen.getByTestId(`numbers-save-${POST}`));
    expect(screen.getByTestId(`numbers-error-${POST}`)).toHaveTextContent(
      "Numbers are whole, and 0 or more.",
    );
    expect(calls).toEqual([]);

    fireEvent.change(screen.getByTestId(`numbers-shares-${POST}`), { target: { value: "1,200" } });
    fireEvent.change(screen.getByTestId(`numbers-likes-${POST}`), { target: { value: "900" } });
    fireEvent.click(screen.getByTestId(`numbers-save-${POST}`));
    await waitFor(() => {
      expect(calls).toEqual([{ key: `POST ${NUMBERS}`, body: { likes: 900, shares: 1_200 } }]);
    });
  });

  it("removes a pasted link only after asking, and never a post made from Aksharo", async () => {
    const { fetchMock } = render();
    const { calls } = serve(fetchMock, {
      [`DELETE ${REMOVE}`]: () => json(200, { removed: true }),
    });
    fireEvent.click(await screen.findByTestId(`performance-remove-${POST}`));
    expect(calls).toEqual([]);
    fireEvent.click(await screen.findByTestId(`performance-remove-confirm-${POST}`));
    await waitFor(() => {
      expect(calls.map((call) => call.key)).toEqual([`DELETE ${REMOVE}`]);
    });
  });

  it("offers no removal of a post made from Aksharo, and no changes to a viewer", async () => {
    render({ body: performance([post({ source: "postiz", canRemove: false })]) });
    await screen.findByTestId(`performance-post-${POST}`);
    expect(screen.queryByTestId(`performance-remove-${POST}`)).toBeNull();
    expect(screen.getByTestId(`numbers-open-${POST}`)).toBeInTheDocument();

    const viewer = render({ role: "viewer" });
    await within(viewer.container).findByTestId(`performance-post-${POST}`);
    expect(within(viewer.container).queryByTestId(`numbers-open-${POST}`)).toBeNull();
    expect(within(viewer.container).queryByTestId(`add-post-${CLIP}`)).toBeNull();
    expect(within(viewer.container).queryByTestId(`performance-remove-${POST}`)).toBeNull();
  });

  it("names no tool and no machinery to a person", () => {
    for (const text of allPerformanceSentences()) {
      expect(beginnerSafetyViolations(text), text).toEqual([]);
    }
  });
});

describe("<CandidateCard /> with a track record (2026-10-05)", () => {
  it("says a moment was picked partly for being like the workspace's best clips", () => {
    const candidate: RepurposeCandidateItem = {
      id: "01JPWCAND00000000000000000",
      startMs: 60_000,
      endMs: 90_000,
      potentialScore: 81,
      title: "Salary aate hi",
      transcriptExcerpt: "Salary aate hi pehle saving karo.",
      reasons: [
        { label: "standalone", explanation: "AI editor: Makes its point." },
        {
          label: "track_record",
          explanation:
            "Like your clip “Salary aate hi ye galti mat karna” (12.4k views on YouTube): salary, saving.",
        },
      ],
    };
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={candidate}
          clip={undefined}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );
    expect(screen.getByTestId(`track-record-${candidate.id}`)).toHaveTextContent(
      "Like your clip “Salary aate hi ye galti mat karna” (12.4k views on YouTube)",
    );
  });

  it("shows nothing of the kind without one", () => {
    renderWithProviders(
      <ul>
        <CandidateCard
          runId={RUN}
          candidate={{ id: "01JPWCAND00000000000000001", startMs: 0, endMs: 30_000, reasons: [] }}
          clip={undefined}
          previewActive={false}
          onActivatePreview={() => undefined}
        />
      </ul>,
    );
    expect(screen.queryByTestId("track-record-01JPWCAND00000000000000001")).toBeNull();
  });
});
