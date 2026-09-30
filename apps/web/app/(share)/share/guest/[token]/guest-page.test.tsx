import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GUEST_COPY, GuestPageView, mainDownload, shapeFits } from "./guest-page";

import type { GuestClip, GuestPage } from "@/lib/guest/guest-page";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders } from "@/test/harness";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const CLIP_A = "01JS00000000000000000CL1PA";
const CLIP_B = "01JS00000000000000000CL1PB";

function clip(over: Partial<GuestClip> = {}): GuestClip {
  return {
    id: CLIP_A,
    title: "Why most people never save",
    durationMs: 29_000,
    player: {
      shape: "9:16",
      url: "https://media.test/ws/a-9x16.mp4?X-Amz-Expires=1200",
      captioned: true,
      posterUrl: "https://media.test/ws/a-vertical.jpg?X-Amz-Expires=1200",
    },
    videos: [
      {
        shape: "9:16",
        width: 1080,
        height: 1920,
        url: "https://media.test/ws/a-9x16.mp4?download=1",
        cleanUrl: "https://media.test/ws/a-9x16-clean.mp4?download=1",
      },
      {
        shape: "16:9",
        width: 1920,
        height: 1080,
        url: "https://media.test/ws/a-16x9.mp4?download=1",
        cleanUrl: null,
      },
    ],
    images: [
      {
        id: "carousel",
        width: 1080,
        height: 1350,
        urls: ["https://media.test/ws/c-1.jpg", "https://media.test/ws/c-2.jpg"],
      },
    ],
    dubs: [
      {
        language: "hi-IN",
        name: "Hindi",
        videos: [
          {
            shape: "9:16",
            width: 1080,
            height: 1920,
            url: "https://media.test/ws/a-hi.mp4?download=1",
            cleanUrl: null,
          },
        ],
      },
    ],
    hashtags: ["#money"],
    posts: [
      { platform: "any", title: "Never save", text: "The one habit.\n\n#money" },
      { platform: "instagram", title: null, text: "The one habit. #money" },
      { platform: "youtube", title: "The one habit", text: "Watch till the end." },
    ],
    ...over,
  };
}

function page(over: Partial<GuestPage> = {}): GuestPage {
  return {
    title: "Podcast 12",
    guestName: "Priya",
    expiresAt: "2026-10-19T06:00:00.000Z",
    clips: [
      clip(),
      clip({
        id: CLIP_B,
        title: "The one habit",
        player: {
          shape: "9:16",
          url: "https://media.test/ws/b-clean.mp4",
          captioned: false,
          posterUrl: null,
        },
        videos: [
          {
            shape: "9:16",
            width: 1080,
            height: 1920,
            url: null,
            cleanUrl: "https://media.test/ws/b-clean.mp4?download=1",
          },
        ],
        images: [],
        dubs: [],
        posts: [],
      }),
    ],
    comingSoon: 0,
    episode: null,
    ...over,
  };
}

function requests(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
): { method: string; headers: Record<string, string>; body: unknown }[] {
  return fetchMock.mock.calls
    .filter(([input]) => new URL(String(input)).pathname === path)
    .map(([, init]) => {
      const request = init as RequestInit | undefined;
      return {
        method: request?.method ?? "GET",
        headers: (request?.headers ?? {}) as Record<string, string>,
        body: request?.body === undefined ? null : (JSON.parse(String(request.body)) as unknown),
      };
    });
}

function render(data: GuestPage | Response = page()) {
  return renderWithProviders(<GuestPageView token={TOKEN} />, {
    accessToken: null,
    routes: {
      "/guest": data,
      "/guest/downloads": new Response(null, { status: 204 }),
    },
  });
}

/** A click on a download link, without letting jsdom try to navigate to it. */
function download(element: HTMLElement): void {
  element.addEventListener("click", (event) => {
    event.preventDefault();
  });
  fireEvent.click(element);
}

const PHONE = 390;
let width = 1024;

beforeEach(() => {
  width = window.innerWidth;
});

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A clipboard that records what was copied. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  return writeText;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("a guest's page", () => {
  it("greets the guest and shows each clip, asking with the token in a header only", async () => {
    const { fetchMock } = render();
    expect(await screen.findByTestId("guest-page-title")).toHaveTextContent("Podcast 12");
    expect(screen.getByTestId("guest-page-greeting")).toHaveTextContent(/^Hi Priya\. These clips/);
    expect(screen.getByText("This link works until 19 October.")).toBeInTheDocument();
    const first = screen.getByTestId(`guest-clip-${CLIP_A}`);
    expect(within(first).getByText("Clip 1 of 2 · 0:29")).toBeInTheDocument();
    const video = within(first).getByTestId(`guest-video-${CLIP_A}`);
    expect(video).toHaveAttribute("src", "https://media.test/ws/a-9x16.mp4?X-Amz-Expires=1200");
    // A still before it plays, and nothing fetched until then.
    expect(video).toHaveAttribute(
      "poster",
      "https://media.test/ws/a-vertical.jpg?X-Amz-Expires=1200",
    );
    expect(video).toHaveAttribute("preload", "none");

    const [open] = requests(fetchMock, "/guest");
    expect(open?.headers["x-guest-token"]).toBe(TOKEN);
    expect(open?.headers).not.toHaveProperty("Authorization");
    for (const [input] of fetchMock.mock.calls) expect(String(input)).not.toContain(TOKEN);
  });

  it("greets without a name when the team gave none", async () => {
    render(page({ guestName: null }));
    expect(await screen.findByTestId("guest-page-greeting")).toHaveTextContent(
      /^These clips are ready to post/,
    );
  });

  it("downloads the clip in view from the bar, and tells the team", async () => {
    const { fetchMock } = render();
    const main = await screen.findByTestId("guest-download-main");
    expect(screen.getByTestId("guest-download-target")).toHaveTextContent(
      "Clip 1 of 2 · Why most people never save",
    );
    expect(main).toHaveAttribute("href", "https://media.test/ws/a-9x16.mp4?download=1");
    expect(main).toHaveTextContent("Download video");
    download(main);
    await waitFor(() => {
      expect(requests(fetchMock, "/guest/downloads")).toMatchObject([
        {
          method: "POST",
          headers: { "x-guest-token": TOKEN },
          body: { clipId: CLIP_A, file: "video", shape: "9:16" },
        },
      ]);
    });

    // A clip with no captioned video downloads its clean cut, and says so.
    fireEvent.pointerDown(screen.getByTestId(`guest-clip-${CLIP_B}`));
    expect(await screen.findByTestId("guest-download-main")).toHaveTextContent(
      "Download video without captions",
    );
  });

  it("offers every shape with and without captions, each download counted as what it is", async () => {
    const { fetchMock } = render();
    const videos = await screen.findByTestId(`guest-videos-${CLIP_A}`);
    const vertical = within(videos).getByTestId(`guest-videos-${CLIP_A}-9x16`);
    expect(vertical).toHaveTextContent("Vertical 9:16");
    expect(vertical).toHaveTextContent("1080 × 1920");
    download(
      within(vertical).getByRole("link", {
        name: "Download Vertical 9:16 without captions: Why most people never save",
      }),
    );
    const wide = within(videos).getByTestId(`guest-videos-${CLIP_A}-16x9`);
    expect(within(wide).queryByText("Without captions")).not.toBeInTheDocument();
    download(
      within(wide).getByRole("link", {
        name: "Download Landscape 16:9: Why most people never save",
      }),
    );
    // Other languages and images are counted as theirs.
    const dub = screen.getByTestId(`guest-dub-${CLIP_A}-hi-IN`);
    download(within(dub).getByRole("link", { name: /Download Vertical 9:16 Hindi/ }));
    download(screen.getByRole("link", { name: /Download Carousel slide 2/ }));
    await waitFor(() => {
      expect(requests(fetchMock, "/guest/downloads").map((request) => request.body)).toEqual([
        { clipId: CLIP_A, file: "clean", shape: "9:16" },
        { clipId: CLIP_A, file: "video", shape: "16:9" },
        { clipId: CLIP_A, file: "dub", shape: "9:16", language: "hi-IN" },
        { clipId: CLIP_A, file: "image", image: "carousel" },
      ]);
    });
  });

  it("gives the words to post, each with a Copy button, and each platform's under its own name", async () => {
    const writeText = stubClipboard();
    render();
    const words = await screen.findByTestId(`guest-words-${CLIP_A}`);
    expect(within(words).getByTestId(`guest-title-${CLIP_A}`)).toHaveTextContent("Never save");
    await press(within(words).getByTestId(`guest-caption-${CLIP_A}-copy`));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("The one habit.\n\n#money");
    });
    const platforms = within(words).getByTestId(`guest-platforms-${CLIP_A}`);
    expect(within(platforms).getByTestId(`guest-post-${CLIP_A}-instagram`)).toHaveTextContent(
      "Instagram caption",
    );
    expect(within(platforms).getByTestId(`guest-post-${CLIP_A}-youtube-title`)).toHaveTextContent(
      "The one habit",
    );
    expect(within(platforms).getByTestId(`guest-post-${CLIP_A}-youtube`)).toHaveTextContent(
      "Watch till the end.",
    );
    // A clip whose words were never written still offers its title.
    const bare = screen.getByTestId(`guest-words-${CLIP_B}`);
    expect(within(bare).getByTestId(`guest-title-${CLIP_B}`)).toHaveTextContent("The one habit");
    expect(within(bare).queryByTestId(`guest-caption-${CLIP_B}`)).not.toBeInTheDocument();
  });

  it("closes with the episode's own posts, the thread copyable whole", async () => {
    const writeText = stubClipboard();
    render(page({ episode: { linkedin: "What we talked about", xThread: ["1/ One", "2/ Two"] } }));
    const episode = await screen.findByTestId("guest-episode");
    expect(within(episode).getByTestId("guest-episode-linkedin")).toHaveTextContent(
      "What we talked about",
    );
    expect(within(episode).getByText("Post 2 of 2")).toBeInTheDocument();
    await press(within(episode).getByTestId("guest-episode-x-copy"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("1/ One\n\n2/ Two");
    });
  });

  it("says when more clips are still to come, and when none is ready yet", async () => {
    const { unmount } = render(page({ comingSoon: 2 }));
    expect(await screen.findByTestId("guest-coming-soon")).toHaveTextContent(
      "2 more clips are not ready to download yet.",
    );
    unmount();
    render(page({ clips: [], comingSoon: 1 }));
    expect(await screen.findByTestId("guest-page-empty")).toHaveTextContent(
      "No clips are ready to download yet.",
    );
    expect(screen.queryByTestId("guest-download-bar")).not.toBeInTheDocument();
  });

  it.each([
    [410, "guest/link_revoked", "This link was turned off by the people who sent it."],
    [410, "guest/link_expired", "This link has expired."],
    [404, "guest/link_not_found", "This link does not exist."],
  ])("explains a %s %s and does not offer a retry", async (status, code, message) => {
    render(
      new Response(JSON.stringify({ error: { code, message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(await screen.findByTestId("guest-page-gone")).toHaveTextContent(message);
    expect(screen.getByText("Ask the person who sent it for a new link.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("has a Made with Aksharo link, and nothing else of the kind", async () => {
    render();
    const made = await screen.findByTestId("guest-made-with");
    expect(made).toHaveTextContent("Made with Aksharo");
    expect(made).toHaveAttribute("href", "/");
    expect(made).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("is laid out for a phone: one narrow column, and one thumb-sized download fixed to the bottom", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: PHONE });
    window.dispatchEvent(new Event("resize"));
    render();
    const main = await screen.findByTestId("guest-page");
    expect(main.className).toMatch(/\bmax-w-md\b/);
    expect(main.className).toMatch(/\bpx-4\b/);
    expect(main.className).toMatch(/\bpb-40\b/);
    const bar = screen.getByTestId("guest-download-bar");
    expect(bar.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["fixed", "inset-x-0", "bottom-0"]),
    );
    expect(bar.className).toMatch(/safe-area-inset-bottom/);
    const primary = screen.getByTestId("guest-download-main");
    expect(primary.className).toMatch(/\bh-12\b/);
    expect(primary.className).toMatch(/\bw-full\b/);
    // The page's one primary.
    expect(document.querySelectorAll(".text-on-accent")).toHaveLength(1);
    // The video fills the column, tall and vertical.
    const video = screen.getByTestId(`guest-video-${CLIP_A}`);
    expect(video).toHaveClass("aspect-[9/16]", "w-full");
    expect(video).toHaveAttribute("playsinline");
    // Thumb-sized download links.
    for (const link of within(screen.getByTestId(`guest-videos-${CLIP_A}`)).getAllByRole("link")) {
      expect(link.className).toMatch(/\b(h-11|min-h-11)\b/);
    }
  });
});

describe("the guest page's helpers and words", () => {
  it("downloads captions on and vertical first, else the clean cut", () => {
    expect(mainDownload(clip())).toEqual({
      url: "https://media.test/ws/a-9x16.mp4?download=1",
      shape: "9:16",
      captioned: true,
    });
    expect(
      mainDownload(
        clip({
          videos: [
            { shape: "9:16", width: 1, height: 1, url: null, cleanUrl: "clean-9x16" },
            { shape: "1:1", width: 1, height: 1, url: "captioned-1x1", cleanUrl: null },
          ],
        }),
      ),
    ).toEqual({ url: "captioned-1x1", shape: "1:1", captioned: true });
    expect(mainDownload(clip({ videos: [] }))).toBeNull();
  });

  it("says where each shape goes", () => {
    expect(shapeFits("9:16")).toMatch(/^Instagram, Facebook, YouTube/);
    expect(shapeFits("9:16")).toMatch(/ and \w+$/);
  });

  it("never names a tool, a queue or a codename", () => {
    const sentences: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") sentences.push(value);
      else if (typeof value === "function") {
        sentences.push(String((value as (...args: unknown[]) => unknown)(3, 1)));
      } else if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) walk(entry);
      }
    };
    walk(GUEST_COPY);
    for (const text of sentences) expect(beginnerSafetyViolations(text), text).toEqual([]);
  });
});
