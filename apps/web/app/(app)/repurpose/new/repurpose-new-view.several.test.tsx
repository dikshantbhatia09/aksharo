import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepurposeNewView } from "./repurpose-new-view";

import { renderWithProviders } from "@/test/harness";
import { routerMock, searchParamsMock } from "@/test/next-router";

// One spy across renders, so the upload queue's hand-off can be read back.
const addFilesToProjects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/upload/use-upload-queue", () => ({
  useUploadQueue: () => ({
    items: [],
    addFiles: vi.fn(),
    addFilesToProjects,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

/**
 * Several at once (2026-10-02): "Several links" starts one run per link through
 * the bulk route and shows each line's outcome; several files start one upload
 * run each. Both only while `repurpose_automations` is on.
 */
const ENTITLEMENT_PATH = "/workspaces/01JWORKSPACE/entitlement";
const RUNS = "/repurpose/runs";
const BULK = "/repurpose/runs/bulk";

function entitlement(flags: Record<string, boolean>): Record<string, unknown> {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 200,
    seatsIncluded: 1,
    seatsUsed: 1,
    computedAt: "2026-10-02T10:00:00.000Z",
    entitlements: { flags: { repurpose_flow: true, source_youtube_acquire: true, ...flags } },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function postsTo(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
): { body: unknown; headers: Record<string, string> }[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === "POST" &&
        new URL(String(input)).pathname === path,
    )
    .map(([, init]) => ({
      body: JSON.parse(String((init as RequestInit).body)) as unknown,
      headers: Object.fromEntries(new Headers((init as RequestInit).headers).entries()),
    }));
}

beforeEach(() => {
  routerMock.push.mockClear();
  addFilesToProjects.mockClear();
  searchParamsMock.value = new URLSearchParams();
});

describe("<RepurposeNewView /> several at once", () => {
  it("offers neither several links nor several files while the flag is off", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlement({}) },
    });
    expect(await screen.findByTestId("source-tab-link")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("source-tab-links")).toBeNull();
    });
    await userEvent.setup().click(screen.getByTestId("source-tab-upload"));
    expect(screen.getByTestId("source-file")).not.toHaveAttribute("multiple");
  });

  it("offers several files but not several links while YouTube links are off", async () => {
    renderWithProviders(<RepurposeNewView />, {
      routes: {
        [ENTITLEMENT_PATH]: entitlement({
          repurpose_automations: true,
          source_youtube_acquire: false,
        }),
      },
    });
    await userEvent.setup().click(await screen.findByTestId("source-tab-upload"));
    await waitFor(() => {
      expect(screen.getByTestId("source-file")).toHaveAttribute("multiple");
    });
    expect(screen.queryByTestId("source-tab-links")).toBeNull();
  });

  it("starts one run per link, each video once, and shows each line's outcome", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: {
        [ENTITLEMENT_PATH]: entitlement({ repurpose_automations: true }),
        [BULK]: {
          started: 2,
          results: [
            {
              index: 0,
              link: "https://youtu.be/aaaaaaaaaaa",
              outcome: "started",
              runId: "01JRUN0000000000000000000A",
              code: null,
              message: null,
            },
            {
              index: 1,
              link: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
              outcome: "already_running",
              runId: "01JRUN0000000000000000000B",
              code: "repurpose/source_already_running",
              message: "raw api words",
            },
            {
              index: 2,
              link: "https://www.youtube.com/watch?v=ccccccccccc",
              outcome: "refused",
              runId: null,
              code: "repurpose/no_credits",
              message: "raw api words",
            },
          ],
        },
      },
    });

    await user.click(await screen.findByTestId("source-tab-links"));
    await user.type(
      screen.getByTestId("source-links"),
      "youtu.be/aaaaaaaaaaa\nhttps://www.youtube.com/watch?v=bbbbbbbbbbb\n\nhttps://youtube.com/watch?v=aaaaaaaaaaa\nhttps://www.youtube.com/watch?v=ccccccccccc",
    );
    // The repeat is named before anything is sent, and not counted.
    expect(screen.getByTestId("links-summary")).toHaveTextContent("3 videos");
    expect(screen.getByTestId("links-line-4")).toHaveTextContent("the same video as line 1");
    expect(screen.getByTestId("start-run")).toHaveTextContent("Start 3 runs");

    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));

    const results = await screen.findByTestId("several-results");
    const [request] = postsTo(fetchMock, BULK);
    expect(request?.body).toMatchObject({
      links: [
        "https://youtu.be/aaaaaaaaaaa",
        "https://www.youtube.com/watch?v=bbbbbbbbbbb",
        "https://www.youtube.com/watch?v=ccccccccccc",
      ],
      rightsAttested: true,
      setup: { sourceLanguage: "auto", automation: "auto", discovery: { mode: "ai" } },
    });
    expect(request?.headers["idempotency-key"]).toMatch(/^repurpose-/);
    expect(postsTo(fetchMock, RUNS)).toHaveLength(0);
    // No navigation: the outcome is here, line by line, in the page's words.
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(within(results).getByTestId("several-line-link-0")).toHaveTextContent("Started");
    expect(within(results).getByTestId("several-open-link-0")).toHaveAttribute(
      "href",
      "/repurpose/01JRUN0000000000000000000A",
    );
    expect(within(results).getByTestId("several-line-link-1")).toHaveTextContent("Already running");
    expect(within(results).getByTestId("several-line-link-2")).toHaveTextContent(/out of credits/i);
    expect(results).not.toHaveTextContent("raw api words");
  });

  it("will not send a box with a line that is not a link", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlement({ repurpose_automations: true }) },
    });
    await user.click(await screen.findByTestId("source-tab-links"));
    await user.type(screen.getByTestId("source-links"), "https://youtu.be/aaaaaaaaaaa\nnot a link");
    await user.click(screen.getByTestId("rights-attested"));
    await user.click(screen.getByTestId("start-run"));
    expect(
      await screen.findByText("Some lines are not links. Fix or remove them."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("links-line-2")).toHaveTextContent("This line is not a link.");
    expect(postsTo(fetchMock, BULK)).toHaveLength(0);
  });

  it("starts one upload run per file, hands them all to the queue, and opens the run list", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlement({ repurpose_automations: true }) },
    });
    const through = fetchMock.getMockImplementation();
    let n = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === RUNS && init?.method === "POST") {
        n += 1;
        return Promise.resolve(
          json(201, {
            run: { id: `01JRUN000000000000000000${String(n).padStart(2, "0")}` },
            projectId: `01JPROJECT00000000000000${String(n).padStart(2, "0")}`,
            upload: null,
            next: { rel: "run", href: "/x" },
          }),
        );
      }
      return (through as (i: RequestInfo | URL) => Promise<Response>)(input);
    });

    await user.click(await screen.findByTestId("source-tab-upload"));
    const files = [
      new File(["a"], "episode-1.mp4", { type: "video/mp4" }),
      new File(["b"], "episode-2.mov", { type: "video/quicktime" }),
    ];
    await user.upload(screen.getByTestId("source-file"), files);
    expect(screen.getByTestId("selected-files")).toHaveTextContent("episode-1.mp4");
    expect(screen.getByTestId("start-run")).toHaveTextContent("Start 2 runs");
    await user.click(screen.getByTestId("start-run"));

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/repurpose");
    });
    const bodies = postsTo(fetchMock, RUNS).map((post) => post.body) as {
      source: { filename: string; issueUploadTicket: boolean };
    }[];
    expect(bodies.map((body) => body.source.filename)).toEqual(["episode-1.mp4", "episode-2.mov"]);
    expect(bodies.every((body) => !body.source.issueUploadTicket)).toBe(true);
    // Each file into its own run's project, in one hand-off.
    expect(addFilesToProjects).toHaveBeenCalledOnce();
    const [pairs] = addFilesToProjects.mock.calls[0] as [{ file: File; projectId: string }[]];
    expect(pairs.map((pair) => [pair.file.name, pair.projectId])).toEqual([
      ["episode-1.mp4", "01JPROJECT0000000000000001"],
      ["episode-2.mov", "01JPROJECT0000000000000002"],
    ]);
  });

  it("keeps the files that did not start, and says why, when some are refused", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<RepurposeNewView />, {
      routes: { [ENTITLEMENT_PATH]: entitlement({ repurpose_automations: true }) },
    });
    const through = fetchMock.getMockImplementation();
    let n = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === RUNS && init?.method === "POST") {
        n += 1;
        return Promise.resolve(
          n === 2
            ? json(429, { error: { code: "common/rate_limited", message: "raw api words" } })
            : json(201, {
                run: { id: `01JRUN000000000000000000${String(n).padStart(2, "0")}` },
                projectId: `01JPROJECT00000000000000${String(n).padStart(2, "0")}`,
                upload: null,
                next: { rel: "run", href: "/x" },
              }),
        );
      }
      return (through as (i: RequestInfo | URL) => Promise<Response>)(input);
    });

    await user.click(await screen.findByTestId("source-tab-upload"));
    await user.upload(screen.getByTestId("source-file"), [
      new File(["a"], "one.mp4", { type: "video/mp4" }),
      new File(["b"], "two.mp4", { type: "video/mp4" }),
    ]);
    await user.click(screen.getByTestId("start-run"));

    const results = await screen.findByTestId("several-results");
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(within(results).getByTestId("several-line-file-0")).toHaveTextContent("Started");
    expect(within(results).getByTestId("several-line-file-1")).toHaveTextContent(
      "That was a lot of requests at once",
    );
    expect(results).not.toHaveTextContent("raw api words");
    // The file that started is uploading; the form now holds only the other.
    expect(addFilesToProjects).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected-file")).toHaveTextContent("two.mp4");
  });
});
