import { IDEMPOTENCY_HEADER } from "../public-api.constants.js";

import type { IdempotencyService } from "./idempotency.service.js";
import type { Request } from "express";

/**
 * Run `produce()` once per `Idempotency-Key`, replaying the first answer on a
 * retry (B14 §2). Every mutating `/v1` route calls this rather than each
 * reimplementing "check, run, save".
 */
export async function withIdempotency<T>(
  service: IdempotencyService,
  request: Request,
  workspaceId: string,
  route: string,
  body: unknown,
  produce: () => Promise<T>,
): Promise<T> {
  const header = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || key === "") return produce();

  const replay = await service.find(workspaceId, route, key, body);
  if (replay !== undefined) return replay.body as T;

  const result = await produce();
  await service.save(workspaceId, route, key, body, { status: 200, body: result });
  return result;
}
