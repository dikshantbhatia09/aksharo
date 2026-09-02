import { createHash } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";

import { AppException, PrismaService } from "../../common/index.js";
import { IDEMPOTENCY_TTL_MS, PUBLIC_API_ERRORS } from "../public-api.constants.js";

export interface IdempotentReplay {
  readonly status: number;
  readonly body: unknown;
}

/**
 * `Idempotency-Key` replay for `/v1/*` (B14 §2): a caller that retries a
 * `POST` after a dropped response gets the *same* answer back rather than a
 * second project/export/transcription.
 *
 * Keyed on `(workspaceId, route, key)` — the same key from two different
 * workspaces (impossible, since a key belongs to one caller) or two different
 * routes never collide. A **different body** under the same key is a caller
 * bug (reusing a key for a different request) and is refused with
 * `public_api/idempotency_conflict` rather than silently replaying the first
 * request's answer for a second, different one.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    workspaceId: string,
    route: string,
    key: string,
    body: unknown,
  ): Promise<IdempotentReplay | undefined> {
    const id = recordId(workspaceId, route, key);
    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { id } });
    if (existing === null) return undefined;
    if (existing.expiresAt.getTime() <= Date.now()) return undefined;

    const requestHash = hashBody(body);
    if (existing.requestHash !== requestHash) {
      throw new AppException(
        PUBLIC_API_ERRORS.idempotencyConflict,
        "This Idempotency-Key was already used with a different request body.",
        HttpStatus.CONFLICT,
      );
    }
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  async save(
    workspaceId: string,
    route: string,
    key: string,
    body: unknown,
    response: { readonly status: number; readonly body: unknown },
  ): Promise<void> {
    const id = recordId(workspaceId, route, key);
    const now = new Date();
    await this.prisma.idempotencyRecord.upsert({
      where: { id },
      create: {
        id,
        workspaceId,
        requestHash: hashBody(body),
        responseStatus: response.status,
         
        responseBody: (response.body ?? null) as never,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      },
      update: {},
    });
  }
}

function recordId(workspaceId: string, route: string, key: string): string {
  return createHash("sha256").update(`${workspaceId}:${route}:${key}`, "utf8").digest("hex");
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {}), "utf8").digest("hex");
}
