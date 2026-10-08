import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

export interface CloudStreamResult {
  readonly stream: Readable;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly mimeType: string;
}

export async function getGoogleDriveStream(options: {
  readonly fileId: string;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  readonly customFetch?: typeof fetch;
}): Promise<CloudStreamResult> {
  const { fileId, accessToken, signal, customFetch = fetch } = options;

  // 1. Fetch metadata (supportsAllDrives=true for Google Workspace Shared Drives)
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

  // 2. Fetch binary stream with virus warning bypass
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
    throw new Error(`Failed to download Google Drive file (status ${response.status}): ${err}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Check if Google returned an HTML interstitial warning (>100MB)
  if (contentType.includes("text/html")) {
    const htmlBody = await response.text();
    let confirmToken: string | null = null;

    const setCookie = response.headers.get("set-cookie") || "";
    const cookieMatch = setCookie.match(/download_warning_[\w-]+=\s*([^;]+)/i);
    if (cookieMatch?.[1]) {
      confirmToken = cookieMatch[1];
    }

    if (!confirmToken) {
      const inputMatch =
        htmlBody.match(/name="confirm"\s+value="([^"]+)"/i) ||
        htmlBody.match(/value="([^"]+)"\s+name="confirm"/i) ||
        htmlBody.match(/[?&]confirm=([a-zA-Z0-9_-]+)/i);
      if (inputMatch?.[1]) {
        confirmToken = inputMatch[1];
      }
    }

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

  const nodeReadable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);

  return {
    stream: nodeReadable,
    fileName,
    fileSizeBytes,
    mimeType,
  };
}

export async function getDropboxStream(options: {
  readonly pathOrId?: string;
  readonly directLink?: string;
  readonly accessToken?: string;
  readonly signal?: AbortSignal;
  readonly customFetch?: typeof fetch;
}): Promise<CloudStreamResult> {
  const { pathOrId, directLink, accessToken, signal, customFetch = fetch } = options;

  let downloadUrl = directLink;
  let fileName = "dropbox-video.mp4";
  let fileSizeBytes = 0;

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
    let parsedUrl = directLink;
    if (parsedUrl.includes("dropbox.com") && !parsedUrl.includes("dl.dropboxusercontent.com")) {
      const u = new URL(parsedUrl);
      u.searchParams.set("dl", "1");
      parsedUrl = u.toString();
    }
    downloadUrl = parsedUrl;

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

  const nodeReadable = Readable.fromWeb(streamRes.body as import("node:stream/web").ReadableStream);

  return {
    stream: nodeReadable,
    fileName,
    fileSizeBytes,
    mimeType,
  };
}

export async function uploadStreamToS3(options: {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly stream: Readable;
  readonly contentType?: string;
  readonly totalExpectedBytes?: number;
  readonly partSize?: number;
  readonly queueSize?: number;
  readonly onProgress?: (progress: {
    loaded: number;
    total?: number;
    percentage: number;
  }) => void;
  readonly signal?: AbortSignal;
}): Promise<{ bucket: string; key: string; totalBytesUploaded: number }> {
  const {
    client,
    bucket,
    key,
    stream,
    contentType = "video/mp4",
    totalExpectedBytes,
    partSize = 16 * 1024 * 1024,
    queueSize = 4,
    onProgress,
    signal,
  } = options;

  let loadedBytes = 0;

  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: stream,
      ContentType: contentType,
    },
    partSize,
    queueSize,
    leavePartsOnError: false,
  });

  if (signal) {
    signal.addEventListener("abort", () => {
      upload.abort();
    });
  }

  upload.on("httpUploadProgress", (progress: { loaded?: number; total?: number }) => {
    if (typeof progress.loaded === "number") {
      loadedBytes = progress.loaded;
    }
    const total = progress.total || totalExpectedBytes;
    const percentage =
      total && total > 0 ? Math.min(100, Math.round((loadedBytes / total) * 100)) : 0;

    onProgress?.({
      loaded: loadedBytes,
      total,
      percentage,
    });
  });

  await upload.done();

  return {
    bucket,
    key,
    totalBytesUploaded: loadedBytes,
  };
}

