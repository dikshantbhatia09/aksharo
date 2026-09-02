import { SetMetadata } from "@nestjs/common";

/** Reflector key {@link AccessLogInterceptor} reads. */
export const ACCESS_LOG_RESOURCE_KEY = "montaj:access-log:resource";

/**
 * Marks a route as a read of personal data, for `access_logs` (D61 Rule 6,
 * B16 brief §2: "access-log middleware writing `access_logs` for reads of
 * personal data (projects/media/transcripts/exports)").
 *
 * A decorator rather than a blanket "every GET is logged" middleware, for two
 * reasons: a middleware runs *before* `JwtAuthGuard`, so `request.principal`
 * — who is reading — does not exist yet at that point in the pipeline, and
 * because most `GET`s are not personal-data reads (`GET /styles`, `GET
 * /plans`) and logging every one of them would make `access_logs` the busiest
 * table in the database for no compliance benefit. `AccessLogInterceptor`
 * (an `Interceptor`, which runs after guards) reads this metadata and writes
 * one row per marked, successful request.
 *
 * `resource` is the same free-text `access_logs.resource` column
 * `CommonAuditService` already writes for mutations — `"project"`, `"media"`,
 * `"transcript"`, `"export"` — so a query does not have to know whether a row
 * came from a read or a write to find every touch of one kind of resource.
 */
export const LogAccess = (resource: string): MethodDecorator =>
  SetMetadata(ACCESS_LOG_RESOURCE_KEY, resource);
