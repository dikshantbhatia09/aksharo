import { createHash } from "node:crypto";

import { CanActivate, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { type AuthenticatedRequest, clientIp } from "./principal.js";
import { type BucketSpec, RateLimitService } from "./rate-limit.service.js";
import { AppException, ERROR_CODES } from "../errors/error-codes.js";

import type { ExecutionContext } from "@nestjs/common";
import type { Response } from "express";

export const RATE_LIMIT_KEY = "montaj:rate-limit";

/**
 * What the bucket is keyed on.
 *
 * `email` reads the request body, which Express has already parsed by the time a
 * guard runs. The value is hashed before it becomes part of a Redis key: an
 * address is personal data (DPDP) and Redis keys end up in slow-log output.
 */
export type RateLimitSubject = "ip" | "user" | "email";

export interface RateLimitRule extends BucketSpec {
  readonly by: RateLimitSubject;
}

/**
 * Attach one or more token buckets to a route.
 *
 * ```ts
 * @RateLimit(
 *   { name: "login:ip", by: "ip", capacity: 20, refillPerSec: 20 / 300 },
 *   { name: "login:account", by: "email", capacity: 10, refillPerSec: 10 / 900 },
 * )
 * ```
 */
export const RateLimit = (...rules: RateLimitRule[]): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_KEY, rules);

/** `sha256(value)`, truncated: enough to be collision-free, short enough to read. */
function subjectHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex").slice(0, 32);
}

function subjectFor(rule: RateLimitRule, request: AuthenticatedRequest): string | undefined {
  switch (rule.by) {
    case "ip":
      return subjectHash(clientIp(request));
    case "user":
      return request.principal === undefined ? undefined : request.principal.userId;
    case "email": {
      const body: unknown = request.body;
      const email =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)["email"]
          : undefined;
      return typeof email === "string" && email !== "" ? subjectHash(email) : undefined;
    }
  }
}

/**
 * Enforces the buckets declared with {@link RateLimit} (THREAT-MODEL T1, T3).
 *
 * A bucket whose subject cannot be resolved (no body email, no principal) is
 * skipped rather than treated as a shared bucket: one global "unknown" bucket
 * would let one caller lock everyone else out.
 *
 * On exhaustion the response carries `Retry-After` (07 §Conventions) and the error
 * is `common/rate_limited` with the bucket name in `details`.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (rules === undefined || rules.length === 0) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    for (const rule of rules) {
      const subject = subjectFor(rule, request);
      if (subject === undefined) continue;

      const verdict = await this.limiter.consume(rule, subject);
      response.setHeader("X-RateLimit-Limit", String(rule.capacity));
      response.setHeader("X-RateLimit-Remaining", String(Math.max(0, verdict.remaining)));

      if (!verdict.allowed) {
        response.setHeader("Retry-After", String(verdict.retryAfterSec));
        throw new AppException(
          ERROR_CODES.rateLimited,
          "Too many requests. Try again shortly.",
          HttpStatus.TOO_MANY_REQUESTS,
          { bucket: rule.name, retryAfterSec: verdict.retryAfterSec },
        );
      }
    }

    return true;
  }
}
