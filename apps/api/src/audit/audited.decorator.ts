import { SetMetadata } from "@nestjs/common";

/** Reflector key the audit-completeness contract test and `AuditedInterceptor` read. */
export const AUDITED_ACTION_KEY = "montaj:audited:action";

/**
 * Tags a route as one whose handler (or the service it calls) writes
 * `audit_log` for this action, and is the marker
 * `audit-completeness.test.ts` — "the audit-completeness contract test B13
 * will reuse" (B16 brief §"Audit log completion") — looks for.
 *
 * Most mutating routes in this codebase already write `audit_log` through
 * `CommonAuditService`/`AuditService`/`AuthAuditService` called from the
 * *service* layer, not the controller (`ConsentsController.set` →
 * `ConsentsService.set` → `audit.record(...)`), so the contract test's
 * primary signal is a static one: does this route's file reference an audit
 * writer at all (`audited-routes.scan.ts`). `@Audited` exists for the
 * routes B16 adds directly in `admin/` — declared here explicitly, rather
 * than left to the file-level heuristic, because an admin route is exactly
 * where "does this file happen to mention Audit somewhere" is not good
 * enough to trust silently.
 */
export const Audited = (action: string): MethodDecorator => SetMetadata(AUDITED_ACTION_KEY, action);
