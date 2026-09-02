import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { tap } from "rxjs";

import { ACCESS_LOG_RESOURCE_KEY } from "./access-log.decorator.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { clientIp } from "../common/guards/principal.js";

import type { AuthenticatedRequest } from "../common/guards/principal.js";
import type { Observable } from "rxjs";

/**
 * Writes `access_logs` for a `@LogAccess(resource)` route, once the request
 * succeeds (D61 Rule 6, B16 brief §2).
 *
 * An `Interceptor`, not a middleware: middleware runs before `JwtAuthGuard`
 * (`access-log.decorator.ts` explains why that rules middleware out), and an
 * interceptor's `handle()` continuation runs after every guard, so
 * `request.principal` is set by the time this reads it.
 *
 * Logged only on success — `tap`, not `catchError` — because a **failed**
 * read (403, 404) did not actually disclose the resource; logging it as an
 * access would overstate what happened. `resourceId` is the route's first
 * path parameter, whatever it is named (`:projectId`, `:mediaId`,
 * `:exportId`, ...) — every route this decorator marks has exactly one.
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: CommonAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource = this.reflector.get<string | undefined>(
      ACCESS_LOG_RESOURCE_KEY,
      context.getHandler(),
    );
    if (resource === undefined) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    return next.handle().pipe(
      tap(() => {
        if (principal === undefined) return;
        const resourceId = Object.values(request.params ?? {})[0] as string | undefined;
        void this.audit.recordAccess({
          action: `${resource}.read`,
          resource,
          ...(resourceId === undefined ? {} : { resourceId }),
          actorId: principal.userId,
          workspaceId: principal.workspaceId,
          ip: clientIp(request),
        });
      }),
    );
  }
}
