import { createHash } from "node:crypto";

import { Controller, Get, Headers, HttpCode, HttpStatus, Res, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

import { InternalSignatureGuard } from "./internal-signature.guard.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { Response } from "express";

/**
 * `GET /internal/routing/overrides` — the worker-ai side of the admin
 * console's routing-weight overrides (B13b, following up on B13's
 * `AdminRoutingController`, whose own comment names this exact seam as
 * "this WP does not build").
 *
 * `apps/api` and `apps/worker-ai` are separately deployed processes; this is
 * the seam that lets a `PUT /admin/routing/weights` change actually reach a
 * running worker without either side reaching across the monorepo boundary
 * at runtime. The wire shape matches `RoutingTable.apply_overrides` on the
 * worker side exactly (`apps/worker-ai/worker_ai/routing.py`):
 *
 * ```json
 * { "lanes": { "<laneId>": { "candidates": { "<provider>": { "weight": 100 } } } } }
 * ```
 *
 * Signed like every other `/internal/**` route (CONTRACTS §3,
 * `InternalSignatureGuard`) — a worker has no user, so this is never a JWT.
 * `GET` is not mutating, so this controller is outside the audit-completeness
 * scan's remit (`audited-routes.scan.ts` only looks for Post/Put/Patch/Delete)
 * and does not need an `EXEMPT_FILES` entry.
 *
 * ETag is the whole row set's content hash: the worker's `routing_overrides.py`
 * caches this for 60s and only re-parses the body when the hash changes, so a
 * quiet admin console costs the worker one small signed GET a minute rather
 * than a fetch-and-diff on every job.
 */
@ApiExcludeController()
@UseGuards(InternalSignatureGuard)
@Controller("internal/routing/overrides")
export class InternalRoutingOverridesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async get(
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown> | undefined> {
    const rows = await this.prisma.routingWeightOverride.findMany({
      orderBy: [{ laneId: "asc" }, { provider: "asc" }],
    });

    const body = toWireShape(rows);
    const etag = etagOf(body);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=60");

    if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
      response.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return body;
  }
}

interface OverrideRow {
  readonly laneId: string;
  readonly provider: string;
  readonly weight: number;
}

/** `{ lanes: { [laneId]: { candidates: { [provider]: { weight } } } } }` — see the class doc. */
export function toWireShape(rows: readonly OverrideRow[]): { lanes: Record<string, unknown> } {
  const lanes: Record<string, { candidates: Record<string, { weight: number }> }> = {};
  for (const row of rows) {
    const lane = (lanes[row.laneId] ??= { candidates: {} });
    lane.candidates[row.provider] = { weight: row.weight };
  }
  return { lanes };
}

/** A weak content hash — good enough for "has the override set changed", never a security check. */
export function etagOf(body: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  return `W/"${hash}"`;
}
