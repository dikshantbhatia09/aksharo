import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReplaceMediaButton } from "./ReplaceMediaButton";

import { renderWithProviders } from "@/test/harness";

const PROJECT_ID = "01JPROJECT";
const MEDIA_ID = "01JMEDIA";

const MEDIA_VIEW = {
  id: MEDIA_ID,
  projectId: PROJECT_ID,
  role: "primary",
  bucket: "s3",
  storageKey: `ws/01JWORKSPACE/p/${PROJECT_ID}/media/${MEDIA_ID}/raw.mp4`,
  filename: "new-cut.mp4",
  mime: "video/mp4",
  sizeBytes: 2_000_000,
  contentHash: null,
  durationMs: 60_000,
  fps: 30,
  width: 1080,
  height: 1920,
  audioChannels: 2,
  status: "uploading",
  needsRealign: true,
  uploadedAt: null,
  rawPurgeAt: null,
  derivedPurgeAt: null,
  derived: { proxy: null, audio16k: null, audio48k: null, waveform: null, thumbs: [] },
  createdAt: "2026-09-08T00:00:00.000Z",
};

const UPLOAD_TICKET = {
  mediaId: MEDIA_ID,
  uploadId: "01JUPLOAD",
  key: MEDIA_VIEW.storageKey,
  bucket: "s3",
  partSizeBytes: 8 * 1024 * 1024,
  parts: [{ partNumber: 1, url: "https://storage.test/raw.mp4?partNumber=1&sig=abc" }],
  expiresAt: "2026-09-08T00:10:00.000Z",
  duplicate: false,
  media: MEDIA_VIEW,
};

function makeFile(name: string, sizeBytes: number, type = "video/mp4"): File {
  const file = new File([new Uint8Array(Math.min(sizeBytes, 1024))], name, { type });
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

/**
 * A part upload PUTs straight to the presigned URL over `XMLHttpRequest`
 * (`apps/web/lib/upload/part-upload.ts`'s own doc comment: `fetch` cannot
 * report upload progress), not `fetch` — so exercising the real
 * `MultipartUpload` engine this button drives needs a fake XHR, the same
 * shape `part-upload.test.ts` uses, wired up as the global constructor
 * rather than injected (this component has no `xhrFactory` seam, correctly:
 * that is a test concern, not a product one).
 */
class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 0;
  upload: { onprogress: ((event: { loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(): void {
    // no-op — the fake resolves any URL identically
  }

  send(): void {
    this.status = 200;
    this.headers = { ETag: '"replaced-etag"' };
    queueMicrotask(() => this.onload?.());
  }

  abort(): void {
    this.onabort?.();
  }

  setRequestHeader(): void {
    // unused by the module under test
  }

  getResponseHeader(name: string): string | null {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a fixed test header set, not attacker-controlled
    return this.headers[name] ?? null;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
});

describe("<ReplaceMediaButton />", () => {
  it("is disabled with a documented reason when there is no media to replace", () => {
    renderWithProviders(<ReplaceMediaButton projectId={PROJECT_ID} mediaId={undefined} />);
    const button = screen.getByTestId("replace-media-button");
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toContain("no source media to replace yet");
  });

  it("is enabled and opens the upload dialog when there is media", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReplaceMediaButton projectId={PROJECT_ID} mediaId={MEDIA_ID} />);
    const button = screen.getByTestId("replace-media-button");
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(await screen.findByTestId("replace-media-dialog")).toBeInTheDocument();
  });

  it("wires the full replace flow: ticket, part upload, and complete with etags", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    const { fetchMock } = renderWithProviders(
      <ReplaceMediaButton projectId={PROJECT_ID} mediaId={MEDIA_ID} />,
      {
        routes: {
          [`/projects/${PROJECT_ID}/media/${MEDIA_ID}/replace`]: UPLOAD_TICKET,
          [`/projects/${PROJECT_ID}/media/${MEDIA_ID}/complete`]: {
            media: { ...MEDIA_VIEW, status: "probing" },
            probeJobId: "01JJOB",
            proxyJobId: null,
          },
        },
      },
    );

    await user.click(screen.getByTestId("replace-media-button"));
    await user.click(screen.getByTestId("replace-media-choose-file"));

    const file = makeFile("new-cut.mp4", 1024);
    const input = screen.getByTestId("replace-media-file-input");
    await user.upload(input, file);

    // `replace` was called (through the real, typed API client).
    await waitFor(() => {
      const replaceCall = fetchMock.mock.calls.find(([requestInput]) =>
        String(requestInput).includes(`/media/${MEDIA_ID}/replace`),
      );
      expect(replaceCall).toBeDefined();
    });

    // The dialog closes once `complete` lands with the collected etags.
    await waitFor(() => {
      expect(screen.queryByTestId("replace-media-dialog")).toBeNull();
    });
    const completeCall = fetchMock.mock.calls.find(([requestInput]) =>
      String(requestInput).includes(`/media/${MEDIA_ID}/complete`),
    );
    expect(completeCall).toBeDefined();
    const body = JSON.parse(String((completeCall?.[1] as RequestInit).body));
    // `part-upload.ts` passes the `ETag` response header through verbatim —
    // S3 sends it quoted, and `CompleteUploadDto`'s own doc comment says
    // quoting is not the caller's problem to strip.
    expect(body.etags).toEqual(['"replaced-etag"']);
  });

  it("shows an error and keeps the dialog open when the server refuses the replace", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReplaceMediaButton projectId={PROJECT_ID} mediaId={MEDIA_ID} />, {
      routes: {
        [`/projects/${PROJECT_ID}/media/${MEDIA_ID}/replace`]: new Response(
          JSON.stringify({
            error: { code: "media/not_found", message: "No such media." },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      },
    });

    await user.click(screen.getByTestId("replace-media-button"));
    await user.click(screen.getByTestId("replace-media-choose-file"));
    await user.upload(screen.getByTestId("replace-media-file-input"), makeFile("x.mp4", 1024));

    expect(await screen.findByTestId("replace-media-error")).toHaveTextContent("No such media.");
    expect(screen.getByTestId("replace-media-dialog")).toBeInTheDocument();
  });
});
