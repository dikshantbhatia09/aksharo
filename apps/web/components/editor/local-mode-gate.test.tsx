import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "@montaj/api-client";
import type { EdgHot, Segment, TranscriptChunk } from "@montaj/edg";

import {
  LocalModeNotice,
  LocalProjectNotSavedError,
  uploadLocalProjectToCloud,
} from "./local-mode-gate";

function fixtureHot(): EdgHot {
  return {
    meta: { edgId: "e1", projectId: "p-local", revision: 1, schemaVersion: 2 },
    media: [],
    transcript: { transcriptId: "t1", revision: 1, language: "hi-Latn", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "clean-bold" },
  };
}

function fixtureSegments(): Segment[] {
  return [
    { id: "s1", seq: "V", startWordId: "0:0" as never, endWordId: "0:0" as never, startMs: 0, endMs: 400 },
  ];
}

function fixtureChunks(): TranscriptChunk[] {
  return [{ chunkIdx: 0, startMs: 0, endMs: 400, words: [{ wid: "0:0", s: 0, e: 400, t: "Bhai" }] }];
}

describe("LocalModeNotice", () => {
  it("renders the gated feature's name and an Upload to cloud action", () => {
    const onUpload = vi.fn();
    render(<LocalModeNotice feature="passes" onUploadToCloud={onUpload} />);

    expect(screen.getByTestId("local-mode-notice")).toHaveTextContent(
      "upload to cloud to use passes",
    );
    fireEvent.click(screen.getByTestId("local-mode-upload"));
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("renders without an action button when none is given", () => {
    render(<LocalModeNotice feature="cloud rendering" />);
    expect(screen.queryByTestId("local-mode-upload")).toBeNull();
  });

  it("disables the upload button while uploading", () => {
    render(<LocalModeNotice feature="passes" onUploadToCloud={vi.fn()} uploading />);
    expect(screen.getByTestId("local-mode-upload")).toBeDisabled();
    expect(screen.getByTestId("local-mode-upload")).toHaveTextContent("Uploading");
  });
});

describe("uploadLocalProjectToCloud", () => {
  it("posts the local project's hot/segments/chunks to /edg/import", async () => {
    const snapshot = {
      id: "snap-1",
      projectId: "p-local",
      revision: 3,
      hot: fixtureHot(),
      segments: fixtureSegments(),
      chunks: fixtureChunks(),
      createdAt: new Date().toISOString(),
    };
    const local = {
      latestSnapshot: vi.fn(async () => snapshot),
    } as unknown as Parameters<typeof uploadLocalProjectToCloud>[0]["local"];

    let capturedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ edgId: "e-cloud", revision: 1, segments: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => "token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await uploadLocalProjectToCloud({
      local,
      client,
      cloudProjectId: "p-cloud",
      localProjectId: "p-local",
    });

    expect(result.edgId).toBe("e-cloud");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/projects/p-cloud/edg/import");
    expect(capturedBody).toMatchObject({ segments: fixtureSegments() });
    expect((capturedBody as { chunks: unknown[] }).chunks).toEqual(fixtureChunks());
  });

  it("omits chunks from the request when the local project has none", async () => {
    const snapshot = {
      id: "snap-1",
      projectId: "p-local",
      revision: 1,
      hot: fixtureHot(),
      segments: fixtureSegments(),
      chunks: [] as TranscriptChunk[],
      createdAt: new Date().toISOString(),
    };
    const local = {
      latestSnapshot: vi.fn(async () => snapshot),
    } as unknown as Parameters<typeof uploadLocalProjectToCloud>[0]["local"];

    let capturedBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return new Response(JSON.stringify({ edgId: "e-cloud", revision: 1, segments: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = createApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => "token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await uploadLocalProjectToCloud({
      local,
      client,
      cloudProjectId: "p-cloud",
      localProjectId: "p-local",
    });

    expect(capturedBody).not.toHaveProperty("chunks");
  });

  it("throws LocalProjectNotSavedError rather than uploading an empty document", async () => {
    const local = {
      latestSnapshot: vi.fn(async () => null),
    } as unknown as Parameters<typeof uploadLocalProjectToCloud>[0]["local"];
    const client = createApiClient({ baseUrl: "https://api.test", fetch: vi.fn() as never });

    await expect(
      uploadLocalProjectToCloud({
        local,
        client,
        cloudProjectId: "p-cloud",
        localProjectId: "p-local",
      }),
    ).rejects.toThrow(LocalProjectNotSavedError);
  });
});
