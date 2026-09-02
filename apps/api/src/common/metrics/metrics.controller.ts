import { Controller, Get, Header, HttpStatus, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { MetricsService } from "./metrics.service.js";
import { safeEqual } from "../../realtime/auth/access-token.js";
import { AppException, ERROR_CODES } from "../errors/error-codes.js";

import type { Request } from "express";

/** Optional shared secret for `GET /internal/metrics`. Unset means unauthenticated. */
export function metricsToken(source: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = source["MONTAJ_METRICS_TOKEN"]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * `GET /internal/metrics` — the Prometheus scrape endpoint (A08b brief §4).
 *
 * Deliberately **not** in `InternalModule`. Everything there is behind
 * `InternalSignatureGuard`, and an HMAC over `timestamp + "." + body` is
 * unsignable by a scraper: there is no body, and Prometheus has no notion of
 * request signing. So this is a separate controller with its own, weaker door.
 *
 * That door is `MONTAJ_METRICS_TOKEN`: when it is set the request must carry
 * `Authorization: Bearer <token>`, compared in constant time; when it is not, the
 * endpoint is open, which is the right default for a pod whose only ingress is the
 * NetworkPolicy in `infra/k8s/montaj` and whose metrics carry no personal data
 * (METRICS.md forbids `workspace_id`, `project_id`, `job_id` and `user_id` as
 * labels, so a scrape leaks queue shapes and nothing else).
 *
 * It reads `process.env` rather than the validated `Env` for the same reason
 * `MONTAJ_QUEUE_PREFIX` does: CONTRACTS §1 is the frozen list of *product*
 * configuration and this is deployment plumbing.
 */
@ApiExcludeController()
@Controller("internal/metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  // Prometheus accepts `text/plain; version=0.0.4`; the charset makes the
  // exposition format unambiguous for a human reading it with curl.
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  @Header("Cache-Control", "no-store")
  scrape(@Req() request: Request): string {
    const expected = metricsToken();
    if (expected !== undefined) {
      const header = request.headers.authorization ?? "";
      const offered = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
      if (offered === "" || !safeEqual(offered, expected)) {
        throw new AppException(
          ERROR_CODES.unauthorized,
          "A valid metrics token is required.",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }
    return this.metrics.render();
  }
}
