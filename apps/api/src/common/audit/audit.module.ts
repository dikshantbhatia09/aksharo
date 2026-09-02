import { Global, Module } from "@nestjs/common";

import { CommonAuditService } from "./audit.service.js";

/**
 * `CommonAuditService`, global like the rest of `common/*` (B16 addendum).
 *
 * `users/audit.service.ts` (`AuditService`) and `auth/auth-audit.service.ts`
 * (`AuthAuditService`) both extend {@link CommonAuditService} directly rather
 * than being provided from here, so their existing `UsersModule`/`AuthModule`
 * providers keep working without importing this module — this module exists so
 * new call sites (privacy, scheduler) can inject `CommonAuditService` itself.
 */
@Global()
@Module({
  providers: [CommonAuditService],
  exports: [CommonAuditService],
})
export class AuditModule {}
