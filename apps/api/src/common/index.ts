/**
 * The `common` surface every feature module builds on.
 *
 * Import from here (`../common/index.js`) rather than reaching into a file, so a
 * later reshuffle inside `common/` is one edit instead of thirty.
 */

export { CommonModule } from "./common.module.js";
export {
  AppException,
  codeForStatus,
  ERROR_CODE_PATTERN,
  ERROR_CODES,
} from "./errors/error-codes.js";
export type { ErrorCode } from "./errors/error-codes.js";
export { HttpExceptionFilter } from "./errors/http-exception.filter.js";
export type { ErrorEnvelope } from "./errors/http-exception.filter.js";
// Guards, decorators and the rate limiter (A04). Re-exported so a feature module
// keeps importing one path; the implementations live in `./guards/`.
export * from "./guards/index.js";
export {
  LoggingModule,
  pinoHttpOptions,
  requestContextMiddleware,
} from "./logging/logging.module.js";
export {
  maskEmail,
  REDACT_PATHS,
  REDACTED,
  redactLogObject,
  redactValue,
} from "./logging/redaction.js";
export { PrismaModule } from "./prisma/prisma.module.js";
export { PrismaService } from "./prisma/prisma.service.js";
export type { PrismaTransaction, TransactionOptions } from "./prisma/prisma.service.js";
export { RedisModule } from "./redis/redis.module.js";
export { RedisService } from "./redis/redis.service.js";
export {
  newRequestId,
  normaliseRequestId,
  REQUEST_ID_HEADER,
  RequestContext,
} from "./request-context.js";
export type { RequestContextStore } from "./request-context.js";
export { resolveOtlpEndpoint, shutdownTelemetry, startTelemetry } from "./telemetry/otel.js";
export { TelemetryService } from "./telemetry/telemetry.service.js";
export type { StopTelemetry, TelemetryOptions } from "./telemetry/otel.js";
export { zodDto, ZodValidationPipe } from "./validation/zod-validation.pipe.js";
export type { ZodDto } from "./validation/zod-validation.pipe.js";
