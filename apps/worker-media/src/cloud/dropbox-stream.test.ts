import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { getDropboxStream } from "./dropbox-stream.js";

describe("getDropboxStream", () => {
  it("obtains temporary link via Dropbox API and streams binary", async () => {
    const mockContent = "dropbox-binary-stream-sample";
    const customFetch = vi.fn()
      // Call 1: get_temporary_link
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            metadata: { name: "dropbox-podcast.mp4", size: 5242880 },
            link: "https://dl.dropboxusercontent.com/s/tmp123/file.mp4",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Call 2: binary stream
      .mockResolvedValueOnce(
        new Response(mockContent, {
          status: 200,
          headers: { "Content-Type": "video/mp4", "Content-Length": "5242880" },
        }),
      );

    const result = await getDropboxStream({
      pathOrId: "id:sample-dropbox-id",
      accessToken: "sl.sample-token",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(result.fileName).toBe("dropbox-podcast.mp4");
    expect(result.fileSizeBytes).toBe(5242880);
    expect(result.mimeType).toBe("video/mp4");
    expect(result.stream).toBeInstanceOf(Readable);

    expect(customFetch).toHaveBeenNthCalledWith(
      1,
      "https://api.dropboxapi.com/2/files/get_temporary_link",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sl.sample-token",
        }),
      }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(mockContent);
  });

  it("streams directly from a Dropbox Chooser direct link", async () => {
    const mockContent = "dropbox-chooser-file-bytes";
    const customFetch = vi.fn().mockResolvedValueOnce(
      new Response(mockContent, {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "2048" },
      }),
    );

    const result = await getDropboxStream({
      directLink: "https://www.dropbox.com/s/xyz987/talk.mp4?dl=0",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(result.fileName).toBe("talk.mp4");
    expect(result.fileSizeBytes).toBe(2048);
    // Verifies dl=1 was rewritten for raw streaming
    expect(customFetch).toHaveBeenCalledWith(
      "https://www.dropbox.com/s/xyz987/talk.mp4?dl=1",
      expect.anything(),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(mockContent);
  });

  it("throws if required parameters are missing", async () => {
    await expect(getDropboxStream({})).rejects.toThrow(
      /Either \(pathOrId \+ accessToken\) or directLink must be provided/,
    );
  });
});

