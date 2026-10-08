import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable } from "node:stream";

export interface S3StreamUploadOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly key: string;
  readonly stream: Readable;
  readonly contentType?: string;
  readonly totalExpectedBytes?: number;
  readonly partSize?: number; // Default 16MB
  readonly queueSize?: number; // Default 4
  readonly onProgress?: (progress: {
    loaded: number;
    total?: number;
    percentage: number;
  }) => void;
  readonly signal?: AbortSignal;
}

export interface S3StreamUploadResult {
  readonly bucket: string;
  readonly key: string;
  readonly totalBytesUploaded: number;
}

/**
 * Zero-Disk S3 Multipart Streaming Pipeline.
 * Pipes incoming cloud stream directly to S3 / MinIO via AWS SDK @aws-sdk/lib-storage Upload.
 * Consumes < 64MB RAM with zero intermediate disk writes.
 */
export async function uploadStreamToS3(
  options: S3StreamUploadOptions,
): Promise<S3StreamUploadResult> {
  const {
    client,
    bucket,
    key,
    stream,
    contentType = "video/mp4",
    totalExpectedBytes,
    partSize = 16 * 1024 * 1024, // 16MB parts
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

  upload.on("httpUploadProgress", (progress) => {
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

