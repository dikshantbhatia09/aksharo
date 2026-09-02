/** Deployment-tunable numbers for the exports module (not CONTRACTS §1 secrets). */

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
