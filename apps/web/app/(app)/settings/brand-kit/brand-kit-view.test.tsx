import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS } from "@montaj/edg";

import { BrandKitView } from "./brand-kit-view";

import type { BrandKitView as BrandKitResponse } from "@/components/brand-kit/use-brand-kit";

import { renderWithProviders, testAccessToken } from "@/test/harness";

// No CanvasKit in jsdom: the preview's stage stays in its loading state.
vi.mock("@/components/editor/canvas/use-canvaskit", () => ({
  useRenderer: () => ({ backend: undefined, engine: undefined, error: undefined, loading: true }),
}));

const EMPTY: BrandKitResponse = {
  exists: false,
  settings: DEFAULT_BRAND_KIT_SETTINGS,
  logo: null,
  images: {},
  fontFamilies: ["Inter", "Poppins", "Anton"],
  limits: {
    logoMaxBytes: 2 * 1024 * 1024,
    logoContentTypes: ["image/png", "image/jpeg", "image/webp"],
    logoMinSide: 16,
    logoMaxSide: 4096,
    ctaMax: 60,
    handleMax: 40,
  },
  updatedAt: null,
};

const WITH_LOGO: BrandKitResponse = {
  ...EMPTY,
  exists: true,
  logo: {
    assetId: "01JL0G0A55ET00000000000000",
    format: "png",
    contentType: "image/png",
    width: 400,
    height: 200,
    sizeBytes: 12_000,
    url: "https://cdn.test/logo.png",
  },
  images: { "01JL0G0A55ET00000000000000": "https://cdn.test/logo.png" },
  updatedAt: "2026-10-02T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function putCalls(fetchMock: ReturnType<typeof vi.fn>): RequestInit[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input).endsWith("/brand-kit") && (init as RequestInit | undefined)?.method === "PUT",
    )
    .map(([, init]) => init as RequestInit);
}

describe("<BrandKitView />", () => {
  it("starts from the defaults for a workspace with no kit, and saves only after a change", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": EMPTY },
    });
    expect(await screen.findByTestId("brand-kit-status")).toHaveTextContent("No brand kit yet");
    const save = screen.getByTestId("brand-kit-save");
    expect(save).toBeDisabled();

    await user.click(screen.getByTestId("brand-kit-end-card-on"));
    await user.type(screen.getByTestId("brand-kit-end-card-cta"), "Follow for more");
    await user.type(screen.getByTestId("brand-kit-end-card-handle"), "@aksharo");
    await user.selectOptions(screen.getByTestId("brand-kit-caption-font"), "Poppins");
    expect(screen.getByTestId("brand-kit-status")).toHaveTextContent("not saved");
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse(
      String(putCalls(fetchMock)[0]?.body),
    ) as typeof DEFAULT_BRAND_KIT_SETTINGS;
    expect(body.endCard).toMatchObject({
      enabled: true,
      cta: "Follow for more",
      handle: "@aksharo",
      // A new card starts on the secondary colour.
      background: DEFAULT_BRAND_KIT_SETTINGS.colors.secondary,
    });
    expect(body.captions).toEqual({ fontFamily: "Poppins" });
  });

  it("uses a caption colour only when it is switched on, and forgets it when switched off", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": WITH_LOGO },
    });
    await screen.findByTestId("brand-kit-caption-highlight-on");
    expect(screen.getByTestId("brand-kit-caption-highlight")).toBeDisabled();
    await user.click(screen.getByTestId("brand-kit-caption-highlight-on"));
    expect(screen.getByTestId("brand-kit-caption-highlight")).toBeEnabled();
    await user.click(screen.getByTestId("brand-kit-save"));
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse(
      String(putCalls(fetchMock)[0]?.body),
    ) as typeof DEFAULT_BRAND_KIT_SETTINGS;
    expect(body.captions).toEqual({ highlight: DEFAULT_BRAND_KIT_SETTINGS.colors.primary });
  });

  it("shows the logo, and says what removing it does before it does it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrandKitView />, { routes: { "/brand-kit": WITH_LOGO } });
    expect(await screen.findByTestId("brand-kit-logo-image")).toHaveAttribute(
      "src",
      "https://cdn.test/logo.png",
    );
    await user.click(screen.getByTestId("brand-kit-logo-remove"));
    expect(await screen.findByTestId("confirm-action-dialog")).toHaveTextContent(
      "Clips that already have it keep it",
    );
  });

  it("refuses a file that cannot be a logo before anything is sent", async () => {
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": EMPTY },
    });
    const input = (await screen.findByTestId("brand-kit-logo-input")) as HTMLInputElement;
    const file = new File([new Uint8Array(10)], "logo.svg", { type: "image/svg+xml" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    expect(await screen.findByTestId("brand-kit-logo-error")).toHaveTextContent(
      "PNG, JPEG or WebP",
    );
    expect(
      fetchMock.mock.calls.some(([request]) => String(request).includes("/brand-kit/logo")),
    ).toBe(false);
  });

  it("lets a viewer look, not change", async () => {
    renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": WITH_LOGO },
      accessToken: testAccessToken({ role: "viewer" }),
    });
    expect(await screen.findByTestId("brand-kit-status")).toHaveTextContent(
      "Only editors can change the brand kit.",
    );
    expect(screen.getByTestId("brand-kit-save")).toBeDisabled();
    expect(screen.getByTestId("brand-kit-logo-upload")).toBeDisabled();
    expect(screen.getByTestId("brand-kit-color-primary")).toBeDisabled();
  });
});

describe("<BrandKitView /> music (2026-10-04)", () => {
  const TRACK = "01JM0S1C000000000000000000";
  const WITH_MUSIC: BrandKitResponse = {
    ...EMPTY,
    exists: true,
    music: {
      assetId: TRACK,
      format: "mp3",
      contentType: "audio/mpeg",
      durationMs: 83_000,
      sizeBytes: 1_200_000,
      title: "Morning theme",
      url: "https://cdn.test/track.mp3",
      rightsAttestedAt: "2026-10-04T09:00:00.000Z",
      rightsAttestedBy: "01JUSER",
    },
    updatedAt: "2026-10-04T09:00:00.000Z",
  };

  function pick(input: HTMLElement, file: File): void {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  }

  it("shows the kit's track, its length and when its rights were confirmed, with a player", async () => {
    renderWithProviders(<BrandKitView />, { routes: { "/brand-kit": WITH_MUSIC } });
    expect(await screen.findByTestId("brand-kit-music-title")).toHaveTextContent("Morning theme");
    expect(screen.getByTestId("brand-kit-music-facts")).toHaveTextContent("MP3 · 1:23");
    expect(screen.getByTestId("brand-kit-music-facts")).toHaveTextContent("Rights confirmed on");
    expect(screen.getByTestId("brand-kit-music-player")).toHaveAttribute(
      "src",
      "https://cdn.test/track.mp3",
    );
  });

  it("uploads a track only once the rights are confirmed, and sends the confirmation", async () => {
    const user = userEvent.setup();
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: {
        "/brand-kit": EMPTY,
        "/brand-kit/music": {
          assetId: TRACK,
          uploadUrl: "https://upload.test/track.mp3",
          contentType: "audio/mpeg",
          expiresAt: "2026-10-04T10:00:00.000Z",
          maxBytes: 25 * 1024 * 1024,
        },
        [`/brand-kit/music/${TRACK}/complete`]: WITH_MUSIC,
      },
    });
    const input = await screen.findByTestId("brand-kit-music-input");
    pick(input, new File([new Uint8Array(64)], "Morning theme.mp3", { type: "audio/mpeg" }));

    const upload = await screen.findByTestId("brand-kit-music-upload");
    expect(upload).toBeDisabled();
    await user.click(screen.getByTestId("brand-kit-music-rights"));
    expect(upload).toBeEnabled();
    await user.click(upload);

    expect(await screen.findByTestId("brand-kit-music-title")).toHaveTextContent("Morning theme");
    const bodies = fetchMock.mock.calls
      .filter(([request]) => String(request).includes("/brand-kit/music"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
    expect(bodies[0]).toEqual({ contentType: "audio/mpeg", sizeBytes: 64, rightsAttested: true });
    expect(bodies[1]).toEqual({
      contentType: "audio/mpeg",
      rightsAttested: true,
      title: "Morning theme",
    });
    expect(put).toHaveBeenCalledWith(
      "https://upload.test/track.mp3",
      expect.objectContaining({ method: "PUT", headers: { "Content-Type": "audio/mpeg" } }),
    );
  });

  it("refuses a file that cannot be music before anything is sent", async () => {
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": EMPTY },
    });
    const input = await screen.findByTestId("brand-kit-music-input");
    pick(input, new File([new Uint8Array(10)], "track.flac", { type: "audio/flac" }));
    expect(await screen.findByTestId("brand-kit-music-error")).toHaveTextContent("MP3, WAV or M4A");
    expect(screen.queryByTestId("brand-kit-music-pending")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([request]) => String(request).includes("/brand-kit/music")),
    ).toBe(false);
  });

  it("saves whether clips get the music, and how loud, with the rest of the kit", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": WITH_MUSIC },
    });
    await user.click(await screen.findByTestId("brand-kit-music-level-medium"));
    await user.click(screen.getByTestId("brand-kit-save"));
    await waitFor(() => expect(putCalls(fetchMock)).toHaveLength(1));
    const body = JSON.parse(String(putCalls(fetchMock)[0]?.body)) as {
      music: { enabled: boolean; level: string };
    };
    expect(body.music).toEqual({ enabled: true, level: "medium" });

    await user.click(screen.getByTestId("brand-kit-music-on"));
    expect(screen.getByTestId("brand-kit-music-level-quiet")).toBeDisabled();
  });

  it("says what removing the music does before it does it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrandKitView />, { routes: { "/brand-kit": WITH_MUSIC } });
    await user.click(await screen.findByTestId("brand-kit-music-remove"));
    expect(await screen.findByTestId("confirm-action-dialog")).toHaveTextContent(
      "Clips that already have it keep it",
    );
  });

  it("changes nothing for a viewer", async () => {
    renderWithProviders(<BrandKitView />, {
      routes: { "/brand-kit": WITH_MUSIC },
      accessToken: testAccessToken({ role: "viewer" }),
    });
    expect(await screen.findByTestId("brand-kit-music-choose")).toBeDisabled();
    expect(screen.getByTestId("brand-kit-music-on")).toBeDisabled();
  });
});
