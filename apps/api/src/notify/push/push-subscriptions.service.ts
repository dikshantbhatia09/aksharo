import { HttpStatus, Injectable } from "@nestjs/common";
import { ulid } from "ulid";

import { pushEndpointProblem } from "./push-endpoint.js";
import { assertAuthSecret, assertUserAgentPublicKey, base64UrlDecode } from "./web-push.crypto.js";
import { AppException, PrismaService } from "../../common/index.js";
import { NOTIFY_ERRORS } from "../notify.constants.js";

import type { PushSubscription } from "@prisma/client";

/**
 * How many browsers one person keeps notifications on in. A phone, a laptop,
 * a work machine and their spares; past this the oldest is forgotten, so an
 * account that re-subscribes on every visit cannot grow the table forever.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

/** What `POST /me/push-subscriptions` takes: `PushSubscription.toJSON()`, keys decoded or not. */
export interface SavePushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** 400 `notify/push_subscription_invalid`, with the one plain reason. */
function invalid(message: string): AppException {
  return new AppException(NOTIFY_ERRORS.pushSubscriptionInvalid, message, HttpStatus.BAD_REQUEST);
}

/**
 * The `push_subscriptions` table: which browsers a person gets device
 * notifications in (2026-09-29).
 *
 * Everything a browser sends is checked before it is kept, because the API
 * later acts on it: the endpoint is only ever one of the browser vendors' push
 * services (`push-endpoint.ts`, which is what stops a subscription from turning
 * the API into a request cannon aimed at this machine's own ports), and the
 * keys are a real P-256 point and a 16-byte secret, so a delivery never fails
 * on a key that could never have worked.
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Keep `input` for `userId`. Idempotent on the endpoint: the same browser
   * subscribing again (every visit to the settings page re-syncs it) updates
   * its keys and clears its failures. An endpoint another account saved moves
   * to this one — it is one browser profile, and whoever turned notifications
   * on in it last is who it notifies.
   */
  async save(userId: string, input: SavePushSubscriptionInput): Promise<PushSubscription> {
    const problem = pushEndpointProblem(input.endpoint);
    if (problem !== null) {
      throw invalid(
        problem === "unknown_service"
          ? "This browser's notification service is not supported."
          : "That is not a browser notification address.",
      );
    }
    try {
      assertUserAgentPublicKey(base64UrlDecode(input.p256dh));
      assertAuthSecret(base64UrlDecode(input.auth));
    } catch {
      // Not base64url, not a point on P-256, not 16 bytes (`PushKeyError`):
      // the same answer, since the browser is the only thing that can fix it.
      throw invalid("The browser sent notification keys that cannot be used.");
    }

    const saved = await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        id: ulid(),
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
      },
      update: { userId, p256dh: input.p256dh, auth: input.auth, failureCount: 0 },
    });

    // The oldest beyond the cap go; the one just saved is never among them.
    const kept = await this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const surplus = kept.slice(MAX_PUSH_SUBSCRIPTIONS_PER_USER).map((row) => row.id);
    if (surplus.length > 0) {
      await this.prisma.pushSubscription.deleteMany({
        where: { id: { in: surplus.filter((id) => id !== saved.id) } },
      });
    }
    return saved;
  }

  /** Forget one browser of `userId`'s. Another person's endpoint is simply not found. */
  async remove(userId: string, endpoint: string): Promise<boolean> {
    const { count } = await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return count > 0;
  }

  async forUser(userId: string): Promise<PushSubscription[]> {
    return this.prisma.pushSubscription.findMany({ where: { userId } });
  }

  async delivered(id: string, at: Date = new Date()): Promise<void> {
    await this.prisma.pushSubscription.updateMany({
      where: { id },
      data: { lastSuccessAt: at, failureCount: 0 },
    });
  }

  async failed(id: string): Promise<void> {
    await this.prisma.pushSubscription.updateMany({
      where: { id },
      data: { failureCount: { increment: 1 } },
    });
  }

  /** The push service said this subscription is gone (404, 410): it never comes back. */
  async drop(id: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { id } });
  }
}
