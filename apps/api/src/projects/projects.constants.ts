import type { RateLimitRule } from "../common/guards/index.js";

/**
 * Error codes, limits and rate rules for `/projects`, `/folders` and the media
 * ingest path (CONTRACTS §8: every code is `namespace/slug`).
 *
 * Numbers live here rather than in the environment for the reason
 * `jobs.config.ts` gives: CONTRACTS §1 is a frozen list of *product*
 * configuration, and a limit the pricing model depends on moves through review,
 * not through a deployment's env block. Anything genuinely per-plan is read from
 * the entitlement instead (`maxFileBytes`, `maxDurationMs`, `retentionDays`).
 */
export const PROJECT_ERRORS = {
  notFound: "project/not_found",
  invalidState: "project/invalid_state",
  batchTooLarge: "project/batch_too_large",
  folderNotFound: "project/folder_not_found",
  folderCycle: "project/folder_cycle",
  folderNotEmpty: "project/folder_not_empty",
} as const;

export const MEDIA_ERRORS = {
  notFound: "media/not_found",
  invalidState: "media/invalid_state",
  unsupportedType: "media/unsupported_type",
  /** `media/too_large` is in `ERROR_CODES` already; re-exported for symmetry. */
  tooLarge: "media/too_large",
  uploadFailed: "media/upload_failed",
  partsMismatch: "media/parts_mismatch",
} as const;

export const IMPORT_ERRORS = {
  tooLarge: "import/too_large",
  unparsable: "import/unparsable",
  unsupportedKind: "import/unsupported_kind",
  blockedUrl: "import/blocked_url",
  fetchFailed: "import/fetch_failed",
} as const;

/** Default page size for `GET /projects`. */
export const PROJECTS_PAGE_SIZE = 25;

/** Hard ceiling on `limit`, so a caller cannot ask for the whole table. */
export const PROJECTS_MAX_PAGE_SIZE = 100;

/** How many projects one `POST /projects/batch` may create. */
export const PROJECT_BATCH_MAX = 50;

/** How deep folders may nest, so a tree walk always terminates. */
export const FOLDER_MAX_DEPTH = 8;

/**
 * Raw media retention: seven days from upload (D47).
 *
 * Not per plan. The raw file exists so the pipeline can re-derive a proxy or a
 * different audio rate; once the derived artefacts are in place nothing reads it,
 * and it is the most expensive thing we store.
 */
export const RAW_RETENTION_DAYS = 7;

/** Fallback derived retention when a plan's entitlement does not name one. */
export const DEFAULT_DERIVED_RETENTION_DAYS = 7;

/** Rows one `purgeDueMedia()` pass touches, so a backlog holds no long transaction. */
export const PURGE_BATCH = 200;

/** Largest inline subtitle a `POST /projects/{id}/import` body may carry (brief §6). */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** How long `POST /projects/{id}/import-url` may spend fetching. */
export const IMPORT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Media formats an upload may use.
 *
 * Re-exported from `@montaj/config` rather than defined here: the browser's
 * file picker needs the identical list, and when this file was the only copy
 * the web kept a hand-written subset that silently greyed out `.avi`, `.m4v`,
 * `.mpeg` and `.3gp` in the file dialog. One list, two readers.
 */
export {
  ALLOWED_MEDIA_EXTENSIONS,
  ALLOWED_MEDIA_MIME_TYPES,
  MIME_FALLBACK_EXTENSIONS,
} from "@montaj/config";

/**
 * Object tags every upload carries.
 *
 * The retention sweep deletes by key, but a bucket lifecycle rule is the belt to
 * that braces: if the API is down for a fortnight the objects still expire, and
 * an operator can see from the tag alone which bucket an object belongs in.
 */
export const RAW_OBJECT_TAGS: Readonly<Record<string, string>> = { montaj: "raw" };
export const DERIVED_OBJECT_TAGS: Readonly<Record<string, string>> = { montaj: "derived" };

/**
 * Per-caller token buckets on the routes that cost something real.
 *
 * `capacity` is the burst a legitimate user needs — dropping a folder of forty
 * clips signs forty uploads in a few seconds — and `refillPerSec` is the sustained
 * rate. A pair like `capacity: 120, refillPerSec: 120 / 3600` reads as "120 at
 * once, 120 an hour thereafter".
 */
export const PROJECT_RATE_LIMITS = {
  /** Creating projects: generous, but not a loop. */
  createProject: {
    name: "projects:create:user",
    by: "user",
    capacity: 120,
    refillPerSec: 120 / 3600,
  },
  /** Signing an upload costs a `CreateMultipartUpload` against the store. */
  initUpload: {
    name: "media:init:user",
    by: "user",
    capacity: 200,
    refillPerSec: 200 / 3600,
  },
  /** Import parses attacker-supplied text in this process. */
  import: { name: "projects:import:user", by: "user", capacity: 60, refillPerSec: 60 / 3600 },
  /** Import-from-URL also makes an outbound request (THREAT-MODEL T6). */
  importUrl: {
    name: "projects:import-url:user",
    by: "user",
    capacity: 20,
    refillPerSec: 20 / 3600,
  },
} as const satisfies Record<string, RateLimitRule>;
