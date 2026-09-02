/**
 * Error codes owned by the exports domain (CONTRACTS §8: `namespace/slug`).
 *
 * `export/unsupported_in_browser` already lives in `common/errors/error-codes.ts`
 * (named in `07-api-and-contracts.md §Conventions`) and is reused as-is; these are
 * the codes 07 does not enumerate.
 */
export const EXPORT_ERROR_CODES = {
  /** No such project, or it belongs to another workspace (THREAT-MODEL T5). */
  projectNotFound: "export/project_not_found",
  /** The project has no editing document yet — nothing to render. */
  edgNotInitialised: "export/edg_not_initialised",
  /** The project has no primary media to render from. */
  mediaNotReady: "export/media_not_ready",
  /** No such manifest, or it belongs to another workspace. */
  manifestNotFound: "export/manifest_not_found",
  /** The manifest's nonce was already consumed (single-use, THREAT-MODEL T10). */
  manifestAlreadyConsumed: "export/manifest_already_consumed",
  /** `expiresAt` is in the past. */
  manifestExpired: "export/manifest_expired",
  /** The manifest failed to parse or verify. */
  manifestInvalid: "export/manifest_invalid",
  /** No such export, or it belongs to another workspace. */
  exportNotFound: "export/not_found",
  /** The export has no artefact to download yet (still pending, or failed). */
  exportNotReady: "export/not_ready",
  /** The requested subtitle/video format is not available yet (e.g. ASS, DOCX). */
  formatUnavailable: "export/format_unavailable",
  /** The requested subtitle format needs a higher plan. */
  formatUpgradeRequired: "export/format_upgrade_required",
  /** The requested resolution exceeds the workspace's plan. */
  resolutionUpgradeRequired: "export/resolution_upgrade_required",
  /** No such brand asset, or it belongs to another workspace. */
  brandAssetNotFound: "export/brand_asset_not_found",
  /** The uploaded file is not a PNG, or is too large. */
  brandAssetInvalid: "export/brand_asset_invalid",
  /** Too many browser export manifests issued today for a Free workspace (abuse cap). */
  dailyManifestCapExceeded: "export/daily_manifest_cap_exceeded",
} as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[keyof typeof EXPORT_ERROR_CODES];
