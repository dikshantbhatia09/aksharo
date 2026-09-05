/** Deployment-tunable numbers for the exports module (not CONTRACTS §1 secrets). */

import type { $Enums } from "@prisma/client";

/**
 * Browser export manifests a Free workspace may have issued in a rolling 24
 * hours (brief scope item 5: bound abuse of the free, uncosted browser path).
 * Paid plans are not capped here — their watermark and credit meters are the
 * real backstop.
 */
export const FREE_DAILY_BROWSER_MANIFEST_CAP = 20;

/** Exports live 7 days (D47). */
export const EXPORT_RETENTION_DAYS = 7;

/** `ws/{workspaceId}/brand/{assetId}.png` upload URLs (`common/storage` TTLs are for media). */
export const BRAND_ASSET_UPLOAD_URL_TTL_SECONDS = 10 * 60;

/** Cheap PNG-signature sniff, so a client cannot upload an arbitrary file behind `.png`. */
export const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Signed GET URLs for a browser export's sources — the original media, its
 * proxy, and the watermark PNG (A21b, after A19 found the browser exporter had
 * no way to fetch the original: a 540p proxy cannot produce a clean 1080p
 * export). Fifteen minutes, not the five `DOWNLOAD_URL_TTL_SECONDS` covers a
 * finished render's download with: the browser has to decode the whole source
 * before it can start encoding, and a slow connection can outlast five minutes
 * on a multi-hundred-megabyte original. `GET /exports/manifests/{id}/sources`
 * reissues a fresh set when these expire mid-export.
 */
export const SOURCE_URL_TTL_SECONDS = 15 * 60;

/**
 * The subtitle formats that are also `ExportKind` members. S05 moved this here
 * from `render-completion.handler.ts`: the row is now written twice — once at
 * POST time by `exports.service.ts` and once when the sidecars land — and both
 * writers have to name the same kind for the same requested format.
 */
export const SUBTITLE_KINDS = new Set(["srt", "vtt", "txt", "md", "ass"]);

export function exportKindFor(format: string): $Enums.ExportKind {
  return (SUBTITLE_KINDS.has(format) ? format : "txt") as $Enums.ExportKind;
}
