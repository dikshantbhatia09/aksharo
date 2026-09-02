import { CanActivate, HttpStatus, Injectable } from "@nestjs/common";

import { AppException, ERROR_CODES, PrismaService, RateLimitService } from "../../common/index.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { ExecutionContext } from "@nestjs/common";
import type { Response } from "express";

/**
 * Per-key token bucket for `/v1/*` (B14 §1), evaluated after {@link
 * ApiKeyGuard} has attached `request.principal.apiKeyId` — this guard trusts
 * that field and does nothing when it is absent, so it is inert on any route
 * an API key cannot reach in the first place.
 *
 * Reuses `RateLimitService` (A04's Redis token bucket) rather than the sibling
 * `RateLimitGuard`: that guard's `RateLimitSubject` is a closed `"ip" | "user" |
 * "email"` union it does not export a way to extend, and its headers are the
 * `X-RateLimit-*` convention `07-api-and-contracts.md`'s human-facing routes
 * already use. The brief asks for `RateLimit-*` (no `X-` prefix) specifically
 * for `/v1`, which is also the RFC 6585-adjacent draft header convention this
 * kind of developer-facing API typically ships — a second, small guard is
 * cheaper than teaching the shared one two header conventions.
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: RateLimitService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const principal = request.principal;
    if (principal === undefined || principal.kind !== "api" || principal.apiKeyId === undefined) {
      return true;
    }

    const key = await this.prisma.apiKey.findUnique({
      where: { id: principal.apiKeyId },
      select: { rateLimit: true, burstLimit: true },
    });
    const capacity = key?.rateLimit ?? 60;
    const burst = key?.burstLimit ?? capacity * 2;
    const verdict = await this.limiter.consume(
      { name: "public-api-key", capacity: burst, refillPerSec: capacity / 60 },
      principal.apiKeyId,
    );

    response.setHeader("RateLimit-Limit", String(capacity));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, verdict.remaining)));
    response.setHeader("RateLimit-Reset", String(verdict.retryAfterSec));

    if (!verdict.allowed) {
      response.setHeader("Retry-After", String(verdict.retryAfterSec));
      throw new AppException(
        ERROR_CODES.rateLimited,
        "Too many requests. Try again shortly.",
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSec: verdict.retryAfterSec },
      );
    }
    return true;
  }
}
