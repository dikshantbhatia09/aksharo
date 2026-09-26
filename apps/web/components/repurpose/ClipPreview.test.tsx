import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipPreview, lastsForPlayback } from "./ClipPreview";

import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";
import { renderWithProviders } from "@/test/harness";

// `CaptionStage` draws through CanvasKit, which its own suites cover; here it is
// a marker that records what it was handed.
const stageProps = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("@/components/editor/canvas/CaptionStage", () => ({
  CaptionStage: (props: Record<string, unknown>) => {
    stageProps.last = props;
    return <div data-testid="fake-caption-stage">{String(props["src"])}</div>;
  },
}));
// The face track is fetched from a presigned URL; the marker stands for it.
const FACE_TRACK = { tracks: [], fps: 1 };
vi.mock("@/lib/edg/use-face-track", () => ({
  useFaceTrack: (url: string | undefined) => (url === undefined ? undefined : FACE_TRACK),
}));

const EXPORT_ROUTE = "/projects/01CLIPPROJECT/transcript/export";
const PREVIEW_ROUTE = "/projects/01CLIPPROJECT/render-preview";
const VTT = ["WEBVTT", "", "00:00:00.200 --> 00:00:01.300", "Its an editorial", ""].join("\n");
const PROJECTION = {
  canvas: { width: 1080, height: 1920 },
  styles: { defaultStyleId: "punch-pop" },
  segments: [],
  words: [],
};
const RENDER_PREVIEW = {
  proxyUrl: "https://media.test/proxy540.mp4?X-Amz-Signature=a",
  facesUrl: "https://media.test/faces.json?X-Amz-Signature=a",
  durationMs: 30_000,
  aspect: "9:16",
  projection: PROJECTION,
};

describe("<ClipPreview /> drawn the way it exports", () => {
  beforeEach(() => {
    stageProps.last = undefined;
    URL.createObjectURL = vi.fn(() => "blob:clip-captions");
    URL.revokeObjectURL = vi.fn();
  });

  // 2026-09-26: the preview was a WebVTT track in the browser's own font, at
  // the bottom, over faces — not the run's style and not where the export puts
  // it. It now renders the clip project's projection through `CaptionStage`
  // with the system styles and the clip's face track.
  it("renders the clip project's style and face track through CaptionStage once played", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        label="Moment, 9:16 clip"
        testId="clip"
      />,
      { routes: { [PREVIEW_ROUTE]: RENDER_PREVIEW } },
    );

    // Until it is played, a clip holds no stage: only its first frame.
    const play = await screen.findByTestId("clip-play");
    expect(screen.queryByTestId("fake-caption-stage")).toBeNull();
    await user.click(play);

    expect(await screen.findByTestId("fake-caption-stage")).toBeInTheDocument();
    expect(screen.getByTestId("clip")).toHaveAttribute("data-preview", "styled");
    expect(stageProps.last?.["src"]).toBe(RENDER_PREVIEW.proxyUrl);
    expect(stageProps.last?.["projection"]).toEqual(PROJECTION);
    expect(stageProps.last?.["catalogue"]).toBe(SYSTEM_STYLE_MAP);
    expect(stageProps.last?.["faces"]).toBe(FACE_TRACK);
    expect(stageProps.last?.["showSafeZones"]).toBe(false);
    // A clip that draws its own captions never asks for the plain track.
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain(EXPORT_ROUTE);
  });

  it("mounts the stage only for the clip the page says is active", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
        active={false}
        onActivate={onActivate}
      />,
      { routes: { [PREVIEW_ROUTE]: RENDER_PREVIEW } },
    );

    await user.click(await screen.findByTestId("clip-play"));
    expect(onActivate).toHaveBeenCalledOnce();
    // Controlled: pressing play asks the page; nothing mounts until it says so,
    // so two clips can never hold two stages at once.
    expect(screen.queryByTestId("fake-caption-stage")).toBeNull();
  });

  it("shows the stage straight away for the active clip", async () => {
    renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
        active
        onActivate={() => undefined}
      />,
      { routes: { [PREVIEW_ROUTE]: RENDER_PREVIEW } },
    );
    expect(await screen.findByTestId("fake-caption-stage")).toBeInTheDocument();
  });

  it("falls back to the plain clip and its text track while the document does not exist", async () => {
    renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      {
        routes: {
          [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, projection: null },
          [EXPORT_ROUTE]: new Response(VTT, {
            status: 200,
            headers: { "content-type": "text/vtt" },
          }),
        },
      },
    );

    await waitFor(() => {
      expect(screen.getByTestId("clip-captions")).toHaveAttribute("src", "blob:clip-captions");
    });
    expect(screen.getByTestId("clip")).toHaveAttribute("data-preview", "plain");
    expect(screen.queryByTestId("clip-play")).toBeNull();
  });

  it("falls back to the plain clip while the clip is still being prepared (409)", async () => {
    renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      {
        routes: {
          [PREVIEW_ROUTE]: new Response(
            JSON.stringify({ error: { code: "share/not_found", message: "Not yet." } }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        },
      },
    );
    await waitFor(() => {
      expect(screen.getByTestId("clip")).toHaveAttribute("data-preview", "plain");
    });
    expect(screen.getByTestId("clip")).toHaveAttribute("src", "https://media.test/master.mp4");
    expect(screen.queryByTestId("fake-caption-stage")).toBeNull();
  });
});

/** How many times the clip's render preview was asked for. */
function previewFetches(fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"]): number {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === PREVIEW_ROUTE)
    .length;
}

/** A proxy URL signed the way the API signs it: for five minutes. */
function proxyUrl(signature: string): string {
  return `https://media.test/proxy540.mp4?X-Amz-Expires=300&X-Amz-Signature=${signature}`;
}

const T0 = new Date("2026-09-26T10:00:00.000Z").getTime();

describe("<ClipPreview /> on URLs that expire in five minutes", () => {
  beforeEach(() => {
    stageProps.last = undefined;
    URL.createObjectURL = vi.fn(() => "blob:clip-captions");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // The render preview's proxy is signed for 5 minutes (DOWNLOAD_URL_TTL_SECONDS),
  // but the page trusted it for 45 and held it for 50: a clip played a few
  // minutes after the page loaded mounted its stage on a refused URL — black,
  // with no fallback, because the query itself had succeeded.
  it("asks for a fresh preview before playing on one fetched minutes ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const user = userEvent.setup();
    const routes: Record<string, unknown> = {
      [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: proxyUrl("old") },
    };
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      { routes },
    );
    const play = await screen.findByTestId("clip-play");

    vi.setSystemTime(T0 + 3 * 60_000);
    Object.assign(routes, { [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: proxyUrl("fresh") } });
    await user.click(play);

    expect(await screen.findByTestId("fake-caption-stage")).toBeInTheDocument();
    expect(stageProps.last?.["src"]).toBe(proxyUrl("fresh"));
    expect(previewFetches(fetchMock)).toBe(2);
  });

  it("plays straight away on a preview fetched moments ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      { routes: { [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: proxyUrl("a") } } },
    );
    const play = await screen.findByTestId("clip-play");
    vi.setSystemTime(T0 + 20_000);
    await user.click(play);
    expect(await screen.findByTestId("fake-caption-stage")).toBeInTheDocument();
    expect(previewFetches(fetchMock)).toBe(1);
  });

  it("does not ask again for a preview whose URLs are signed for an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const user = userEvent.setup();
    const hourLong = "https://media.test/proxy540.mp4?X-Amz-Expires=3600&X-Amz-Signature=h";
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      { routes: { [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: hourLong } } },
    );
    const play = await screen.findByTestId("clip-play");
    vi.setSystemTime(T0 + 10 * 60_000);
    await user.click(play);
    expect(await screen.findByTestId("fake-caption-stage")).toHaveTextContent(hourLong);
    expect(previewFetches(fetchMock)).toBe(1);
  });

  it("takes a fresh proxy when the playing one fails after its URL expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const routes: Record<string, unknown> = {
      [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: proxyUrl("first") },
    };
    renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
        active
        onActivate={() => undefined}
      />,
      { routes },
    );
    expect(await screen.findByTestId("fake-caption-stage")).toHaveTextContent(proxyUrl("first"));

    // Paused, left for six minutes, played again: the range request is refused.
    vi.setSystemTime(T0 + 6 * 60_000);
    Object.assign(routes, { [PREVIEW_ROUTE]: { ...RENDER_PREVIEW, proxyUrl: proxyUrl("second") } });
    act(() => {
      (stageProps.last?.["onMediaError"] as () => void)();
    });
    await waitFor(() => {
      expect(screen.getByTestId("fake-caption-stage")).toHaveTextContent(proxyUrl("second"));
    });
  });

  // TanStack keeps the data when a refetch after a success fails, but the
  // preview decided from `isSuccess`: one transient 409 (the clip being
  // re-probed) or 5xx swapped the stage being watched for the plain video.
  it("keeps the stage being watched when a later refetch fails", async () => {
    const routes: Record<string, unknown> = { [PREVIEW_ROUTE]: RENDER_PREVIEW };
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
        active
        onActivate={() => undefined}
      />,
      { routes },
    );
    expect(await screen.findByTestId("fake-caption-stage")).toBeInTheDocument();

    Object.assign(routes, {
      [PREVIEW_ROUTE]: new Response(
        JSON.stringify({ error: { code: "media/invalid_state", message: "Not yet." } }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    });
    act(() => {
      (stageProps.last?.["onMediaError"] as () => void)();
    });
    await waitFor(() => {
      expect(previewFetches(fetchMock)).toBe(2);
    });
    // Let the failed refetch settle into the query before looking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("fake-caption-stage")).toBeInTheDocument();
    expect(screen.getByTestId("clip")).toHaveAttribute("data-preview", "styled");
    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).not.toContain(EXPORT_ROUTE);
  });

  // Each poll rebuilds the clip's whole projection on the server. A page of
  // ten ready clips each waiting out a face track that never comes made ~300
  // of them per page view; only the clip being played draws with its track.
  it("does not wait for a face track on a clip nobody is playing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { facesUrl: _faces, ...noFaces } = RENDER_PREVIEW;
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
        active={false}
        onActivate={() => undefined}
      />,
      { routes: { [PREVIEW_ROUTE]: noFaces } },
    );
    await screen.findByTestId("clip-play");
    await vi.advanceTimersByTimeAsync(35_000);
    expect(previewFetches(fetchMock)).toBe(1);
  });
});

describe("lastsForPlayback", () => {
  it("wants more signed life left than the longest clip takes to play", () => {
    expect(lastsForPlayback(proxyUrl("a"), T0, T0 + 30_000)).toBe(true);
    expect(lastsForPlayback(proxyUrl("a"), T0, T0 + 2 * 60_000)).toBe(false);
    const hourLong = "https://media.test/p.mp4?X-Amz-Expires=3600&X-Amz-Signature=h";
    expect(lastsForPlayback(hourLong, T0, T0 + 50 * 60_000)).toBe(true);
    expect(lastsForPlayback(hourLong, T0, T0 + 57 * 60_000)).toBe(false);
    // Unsigned lifetimes are taken as the shortest the API uses.
    expect(lastsForPlayback("https://media.test/p.mp4", T0, T0 + 2 * 60_000)).toBe(false);
  });
});

describe("<ClipPreview />", () => {
  beforeEach(() => {
    // jsdom has no object URLs.
    URL.createObjectURL = vi.fn(() => "blob:clip-captions");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 2026-09-25: the clip's captions used to be burned into the video. The
  // picture is clean now, and the preview lays the clip project's own captions
  // over it as a text track.
  it("plays the clean clip with the clip project's captions as a text track", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
      {
        routes: {
          [EXPORT_ROUTE]: new Response(VTT, {
            status: 200,
            headers: { "content-type": "text/vtt" },
          }),
        },
      },
    );

    expect(screen.getByTestId("clip")).toHaveAttribute("src", "https://media.test/master.mp4");
    await waitFor(() => {
      expect(screen.getByTestId("clip-captions")).toHaveAttribute("src", "blob:clip-captions");
    });
    // The styled preview is asked for first; the track is its fallback.
    const exportCall = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.pathname === EXPORT_ROUTE);
    expect(exportCall?.searchParams.get("format")).toBe("vtt");
    expect(screen.getByTestId("clip-captions")).toHaveAttribute("kind", "captions");
  });

  it("still plays, without captions, when they cannot be fetched", async () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview
        videoUrl="https://media.test/master.mp4"
        projectId="01CLIPPROJECT"
        testId="clip"
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("clip")).toBeInTheDocument();
    expect(screen.queryByTestId("clip-captions")).not.toBeInTheDocument();
  });

  it("asks for nothing when the clip has no project yet", () => {
    const { fetchMock } = renderWithProviders(
      <ClipPreview videoUrl="https://media.test/master.mp4" projectId={undefined} testId="clip" />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("clip")).toBeInTheDocument();
  });
});
