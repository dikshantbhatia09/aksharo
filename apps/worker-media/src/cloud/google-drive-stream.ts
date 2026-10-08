import { Readable } from "node:stream";

export interface GoogleDriveFileMetadata {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface GoogleDriveStreamResult {
  readonly stream: Readable;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly mimeType: string;
}

export interface GoogleDriveStreamOptions {
  readonly fileId: string;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  /** Optional custom fetch implementation for testing and mocking */
  readonly customFetch?: typeof fetch;
}

/**
 * Google Drive direct streaming client.
 * Fetches file metadata, bypasses virus-scan confirmation prompts for >100MB files,
 * and yields a Readable stream directly from Google Drive API.
 * Supports Google Workspace Shared Drives via `supportsAllDrives=true`.
 */
export async function getGoogleDriveStream(
  options: GoogleDriveStreamOptions,
): Promise<GoogleDriveStreamResult> {
  const { fileId, accessToken, signal, customFetch = fetch } = options;

  // 1. Fetch file metadata (with supportsAllDrives=true for Google Workspace Shared Drives)
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId,
  )}?fields=id,name,size,mimeType&supportsAllDrives=true`;

  const metaRes = await customFetch(metaUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal,
  });

  if (!metaRes.ok) {
    const errorText = await metaRes.text().catch(() => "");
    throw new Error(
      `Failed to fetch Google Drive file metadata (status ${metaRes.status}): ${errorText}`,
    );
  }

  const meta = (await metaRes.json()) as {
    id: string;
    name?: string;
    size?: string | number;
    mimeType?: string;
  };

  const fileName = meta.name || `drive-${fileId}.mp4`;
  const fileSizeBytes = meta.size ? Number(meta.size) : 0;
  const mimeType = meta.mimeType || "video/mp4";

  // 2. Fetch binary stream with virus-scan bypass handling
  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    fileId,
  )}?alt=media&supportsAllDrives=true`;

  let response = await customFetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(
      `Failed to download Google Drive file (status ${response.status}): ${err}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";

  // Check if Google returned an HTML interstitial virus-scan warning (>100MB)
  if (contentType.includes("text/html")) {
    const htmlBody = await response.text();
    // Parse confirm token from cookie or HTML form/links
    let confirmToken: string | null = null;

    // Check Set-Cookie headers
    const setCookie = response.headers.get("set-cookie") || "";
    const cookieMatch = setCookie.match(/download_warning_[\w-]+=\s*([^;]+)/i);
    if (cookieMatch?.[1]) {
      confirmToken = cookieMatch[1];
    }

    // Check hidden input or href in HTML
    if (!confirmToken) {
      const inputMatch = htmlBody.match(/name="confirm"\s+value="([^"]+)"/i) ||
        htmlBody.match(/value="([^"]+)"\s+name="confirm"/i) ||
        htmlBody.match(/[?&]confirm=([a-zA-Z0-9_-]+)/i);
      if (inputMatch?.[1]) {
        confirmToken = inputMatch[1];
      }
    }

    // If confirm token found, re-issue request with confirm query parameter & cookie
    if (confirmToken) {
      const confirmUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId,
      )}?alt=media&supportsAllDrives=true&confirm=${encodeURIComponent(confirmToken)}`;

      const cookieHeader = cookieMatch ? cookieMatch[0].split(";")[0] : `download_warning_${fileId}=${confirmToken}`;
      const headersRecord: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
      };
      if (cookieHeader) {
        headersRecord["Cookie"] = cookieHeader;
      }
      response = await customFetch(confirmUrl, {
        headers: headersRecord,
        signal,
      });

      if (!response.ok) {
        throw new Error(
          `Google Drive download confirmed request failed (status ${response.status})`,
        );
      }
    }
  }

  if (!response.body) {
    throw new Error("No response body received from Google Drive stream");
  }

  // Convert Web ReadableStream to Node.js Readable
  const nodeReadable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

  return {
    stream: nodeReadable,
    fileName,
    fileSizeBytes,
    mimeType,
  };
}

