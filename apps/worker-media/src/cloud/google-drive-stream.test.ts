import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { getGoogleDriveStream } from "./google-drive-stream.js";

describe("getGoogleDriveStream", () => {
  it("fetches metadata with Shared Drive support and streams binary data directly", async () => {
    const mockFileContent = "test-video-binary-content-12345";
    const customFetch = vi.fn()
      // Call 1: Metadata
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "drive-file-123",
            name: "team_presentation.mp4",
            size: "104857600",
            mimeType: "video/mp4",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Call 2: Media binary stream
      .mockResolvedValueOnce(
        new Response(mockFileContent, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        }),
      );

    const result = await getGoogleDriveStream({
      fileId: "drive-file-123",
      accessToken: "ya29.sample-token",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(result.fileName).toBe("team_presentation.mp4");
    expect(result.fileSizeBytes).toBe(104857600);
    expect(result.mimeType).toBe("video/mp4");
    expect(result.stream).toBeInstanceOf(Readable);

    // Verify metadata request included supportsAllDrives=true and Bearer token
    expect(customFetch).toHaveBeenCalledWith(
      expect.stringContaining("supportsAllDrives=true"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.sample-token",
        }),
      }),
    );

    // Read stream content
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(mockFileContent);
  });

  it("handles Google Drive virus warning interstitial (>100MB) by parsing confirm token", async () => {
    const mockBinary = "large-file-stream-bytes-after-confirmation";
    const warningHtml = `
      <html><body>
        <form id="download-form" action="/drive/v3/files/large-123" method="get">
          <input type="hidden" name="id" value="large-123">
          <input type="hidden" name="confirm" value="t_CONFIRM_TOKEN_XYZ">
          <input type="submit" value="Download anyway">
        </form>
      </body></html>
    `;

    const customFetch = vi.fn()
      // Call 1: Metadata
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "large-123",
            name: "huge-recording.mp4",
            size: "524288000",
            mimeType: "video/mp4",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Call 2: First attempt returns warning HTML
      .mockResolvedValueOnce(
        new Response(warningHtml, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": "download_warning_large-123=t_CONFIRM_TOKEN_XYZ; Path=/",
          },
        }),
      )
      // Call 3: Second attempt with confirm parameter succeeds
      .mockResolvedValueOnce(
        new Response(mockBinary, {
          status: 200,
          headers: { "Content-Type": "video/mp4" },
        }),
      );

    const result = await getGoogleDriveStream({
      fileId: "large-123",
      accessToken: "ya29.sample-token",
      customFetch: customFetch as unknown as typeof fetch,
    });

    expect(customFetch).toHaveBeenCalledTimes(3);
    // Third call should contain confirm parameter
    expect(customFetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("confirm=t_CONFIRM_TOKEN_XYZ"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.sample-token",
        }),
      }),
    );

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(mockBinary);
  });

  it("throws on failed metadata response", async () => {
    const customFetch = vi.fn().mockResolvedValueOnce(
      new Response("File not found", { status: 404 }),
    );

    await expect(
      getGoogleDriveStream({
        fileId: "nonexistent",
        accessToken: "ya29.test",
        customFetch: customFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Failed to fetch Google Drive file metadata \(status 404\)/);
  });
});

