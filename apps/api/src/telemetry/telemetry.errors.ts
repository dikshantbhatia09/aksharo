import { HttpStatus } from "@nestjs/common";

import { AppException } from "../common/index.js";

/**
 * 403 `telemetry/consent_required` — not one of the 07 §Conventions codes
 * (`error-codes.ts`'s closed `ERROR_CODES` map), so it is a plain string
 * literal here rather than an addition to that shared table: telemetry is the
 * only caller of this code, and `ERROR_CODE_PATTERN` (`namespace/slug`) still
 * validates it.
 */
export const TELEMETRY_CONSENT_ERROR = new AppException(
  "telemetry/consent_required",
  "Telemetry consent has not been granted.",
  HttpStatus.FORBIDDEN,
);
