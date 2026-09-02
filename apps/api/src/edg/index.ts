/**
 * The EDG module's public surface.
 *
 * A11 imports `EdgService` to call `initialise(projectId, transcript)`; A15 and
 * A20 read documents through the same service. Nothing outside this folder should
 * reach for `EdgRepository` directly — the service is where tenancy, the write
 * budget and the realtime echo live.
 */
export { EdgModule } from "./edg.module.js";
export { EdgService } from "./edg.service.js";
export type { EdgDocumentView, EdgInitInput, EdgInitResult, OpBatchInput } from "./edg.service.js";
export { EdgRepository, RestoreInvalidError } from "./edg.repository.js";
export type { CommitInput, CommitOutcome, TextConflict } from "./edg.repository.js";
export {
  EDG_ERROR_CODES,
  MAX_OPS_SINCE_REVISIONS,
  MAX_SEGMENT_PAGE_SIZE,
  REVISION_PAGE_SIZE,
  SEGMENT_PAGE_SIZE,
} from "./edg.errors.js";
export type { EdgErrorCode } from "./edg.errors.js";
export { EDG_OPS_BUCKET, EdgRateLimiter } from "./edg.rate-limit.js";
