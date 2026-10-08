import { Readable } from "node:stream";

export interface DropboxStreamResult {
  readonly stream: Readable;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly mimeType: string;
}

export interface DropboxStreamOptions {
  /** Dropbox file path or file ID (e.g. "id:abc..." or "/Videos/podcast.mp4") */
  readonly pathOrId?: string;
  /** Dropbox direct download link (from Dropbox Chooser) */
  readonly directLink?: string;
  /** OAuth access token */
  readonly accessToken?: string;
  readonly signal?: AbortSignal;
  /** Optional custom fetch implementation for testing */
  readonly customFetch?: typeof fetch;
}

/**
 * Dropbox direct streaming client.
 * Obtains temporary direct download link via Dropbox API / Chooser link,
 * and streams binary directly into Node.js Readable.
 */
export async function getDropboxStream(
  options: DropboxStreamOptions,
): Promise<DropboxStreamResult> {
  const { pathOrId, directLink, accessToken, signal, customFetch = fetch } = options;

  let downloadUrl = directLink;
  let fileName = "dropbox-video.mp4";
  let fileSizeBytes = 0;

  // Case 1: OAuth token + file path/id -> call files/get_temporary_link
  if (pathOrId && accessToken) {
    const res = await customFetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: pathOrId }),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Failed to get Dropbox temporary download link (status ${res.status}): ${errText}`,
      );
    }

    const data = (await res.json()) as {
      metadata: { name: string; size?: number };
      link: string;
    };

    downloadUrl = data.link;
    fileName = data.metadata.name;
    fileSizeBytes = data.metadata.size ?? 0;
  } else if (directLink) {
    // Case 2: Direct link from Dropbox Chooser
    // If Dropbox www link, ensure it triggers raw/direct binary stream
    let parsedUrl = directLink;
    if (parsedUrl.includes("dropbox.com") && !parsedUrl.includes("dl.dropboxusercontent.com")) {
      const u = new URL(parsedUrl);
      u.searchParams.set("dl", "1");
      parsedUrl = u.toString();
    }
    downloadUrl = parsedUrl;

    // Infer filename from URL if possible
    try {
      const u = new URL(downloadUrl);
      const pathname = decodeURIComponent(u.pathname);
      const parts = pathname.split("/");
      const candidateName = parts[parts.length - 1];
      if (candidateName && candidateName.includes(".")) {
        fileName = candidateName;
      }
    } catch {
      // Keep default filename
    }
  } else {
    throw new Error("Either (pathOrId + accessToken) or directLink must be provided for Dropbox stream");
  }

  if (!downloadUrl) {
    throw new Error("No download URL resolved for Dropbox stream");
  }

  // Stream binary from downloadUrl
  const streamRes = await customFetch(downloadUrl, {
    headers: accessToken && !directLink ? { Authorization: `Bearer ${accessToken}` } : {},
    signal,
  });

  if (!streamRes.ok) {
    throw new Error(`Failed to download Dropbox stream (status ${streamRes.status})`);
  }

  if (!fileSizeBytes) {
    const cl = streamRes.headers.get("content-length");
    if (cl) {
      fileSizeBytes = parseInt(cl, 10);
    }
  }

  const mimeType = streamRes.headers.get("content-type") || "video/mp4";

  if (!streamRes.body) {
    throw new Error("No response body received from Dropbox stream");
  }

  const nodeReadable = Readable.fromWeb(
    streamRes.body as import("node:stream/web").ReadableStream,
  );

  return {
    stream: nodeReadable,
    fileName,
    fileSizeBytes,
    mimeType,
  };
}

