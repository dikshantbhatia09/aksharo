import { z } from "zod";

import { MAX_PUSH_ENDPOINT_LENGTH } from "./push-endpoint.js";
import { zodDto } from "../../common/index.js";

import type { RateLimitRule } from "../../common/guards/index.js";

/**
 * `POST /me/push-subscriptions`: exactly what `PushSubscription.toJSON()`
 * gives a page, so the browser's object is posted as it is. The endpoint and
 * the keys are checked properly by `PushSubscriptionsService.save` (allowed
 * push services only, a real P-256 point, a 16-byte secret); this is the shape.
 */
export const savePushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(1).max(MAX_PUSH_ENDPOINT_LENGTH),
  /** Part of `toJSON()`; null in every browser that ships it, and never read. */
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(200),
    auth: z.string().trim().min(1).max(100),
  }),
});
export class SavePushSubscriptionDto extends zodDto(savePushSubscriptionSchema) {}

/** `DELETE /me/push-subscriptions`: the browser that is turning notifications off. */
export const deletePushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(1).max(MAX_PUSH_ENDPOINT_LENGTH),
});
export class DeletePushSubscriptionDto extends zodDto(deletePushSubscriptionSchema) {}

/** `GET /me/push-subscriptions/key`: null when this deployment has no VAPID keys. */
export const pushKeyResponseSchema = z.object({ publicKey: z.string().nullable() });

export const pushSubscriptionResponseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
});

/**
 * Saving is cheap but writes a row; the settings page re-syncs once per visit.
 * Thirty an hour is far past any honest use and far short of filling a table.
 */
export const PUSH_SUBSCRIBE_RATE_LIMIT: RateLimitRule = Object.freeze({
  name: "notify:push-subscribe:user",
  by: "user",
  capacity: 30,
  refillPerSec: 30 / 3600,
});
