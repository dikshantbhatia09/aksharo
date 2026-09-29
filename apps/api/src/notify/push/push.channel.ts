import { Inject, Injectable, Logger, Optional, type OnModuleInit } from "@nestjs/common";

import { pushEndpointProblem } from "./push-endpoint.js";
import { PushSubscriptionsService } from "./push-subscriptions.service.js";
import {
  MAX_PUSH_PLAINTEXT_BYTES,
  base64UrlDecode,
  encryptPushPayload,
  vapidAuthorization,
} from "./web-push.crypto.js";

import type { WebPushSetting } from "./push-env.js";
import type { ChannelDelivery, DeviceMessage, NotificationChannel } from "../notify.channels.js";
import type { PushSubscription } from "@prisma/client";

/** The parsed `WEB_PUSH_*` setting (`push-env.ts`), bound once in `notify.module.ts`. */
export const WEB_PUSH_SETTING = Symbol("WEB_PUSH_SETTING");
/** `fetch`, so the tests can stand in for a push service. */
export const PUSH_FETCH = Symbol("PUSH_FETCH");

/**
 * How long a push service keeps a message for a device that is offline. A day:
 * "your clips are ready" is still news tomorrow morning, and a newer message
 * about the same run replaces it anyway (`Topic`).
 */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** How long one VAPID token is good for: well inside RFC 8292's 24 hours. */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;
/** A push service slower than this is not waited for; the bell still has it. */
const PUSH_TIMEOUT_MS = 10_000;
/**
 * Failures in a row after which a subscription is forgotten: a browser whose
 * push service keeps refusing us (a key rotated under it, a profile deleted
 * without saying so) will never take a message again.
 */
export const MAX_PUSH_FAILURES = 20;
/** RFC 8030 §5.4: a topic is at most 32 characters of base64url. */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/** What the service worker (`apps/web/public/sw.js`) receives, decrypted. */
export interface DevicePayload {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly tag?: string;
  readonly kind: string;
}

/** The JSON a browser gets, kept to one record however long the copy runs. */
export function devicePayload(message: DeviceMessage): Buffer {
  const payload: DevicePayload = {
    title: message.title.slice(0, 120),
    body: message.body.slice(0, 400),
    url: message.url,
    kind: message.kind,
    ...(message.thread === undefined ? {} : { tag: message.thread }),
  };
  let bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > MAX_PUSH_PLAINTEXT_BYTES) {
    bytes = Buffer.from(JSON.stringify({ ...payload, body: payload.body.slice(0, 80) }));
  }
  return bytes;
}

type Outcome = "sent" | "failed" | "removed";

/**
 * Web Push, as a device channel (`notify.channels.ts`): the run notifications
 * a person turned on in a browser, on desktop and on Android, even with the
 * tab closed.
 *
 * Per browser, per message: encrypt to that browser's keys (RFC 8291), sign a
 * VAPID token for that push service (RFC 8292), POST, and act on the answer —
 * 2xx is delivered, 404 and 410 mean the subscription is gone and it is
 * deleted, anything else counts as a failure (and {@link MAX_PUSH_FAILURES} in
 * a row forget it). A redirect is never followed: the endpoint was checked
 * against the push services we allow, and a 3xx must not take the request
 * somewhere that was not (`push-endpoint.ts`).
 *
 * With no VAPID keys configured it is off, which is not an error: the bell and
 * the email still carry every notification.
 */
@Injectable()
export class WebPushChannel implements NotificationChannel, OnModuleInit {
  readonly name = "web-push";
  private readonly logger = new Logger(WebPushChannel.name);
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly subscriptions: PushSubscriptionsService,
    @Inject(WEB_PUSH_SETTING) private readonly setting: WebPushSetting,
    @Optional() @Inject(PUSH_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  onModuleInit(): void {
    if (this.setting.kind === "on") {
      this.logger.log("web push is on");
    } else if (this.setting.kind === "invalid") {
      // Once, and never the value: a key in a log is a key someone else has.
      this.logger.warn(
        { problem: this.setting.problem },
        "WEB_PUSH_* is not usable; web push is off (the bell and email still work)",
      );
    }
  }

  /** The key a browser subscribes with (`applicationServerKey`), or null when push is off. */
  get publicKey(): string | null {
    return this.setting.kind === "on" ? this.setting.publicKey : null;
  }

  async deliver(message: DeviceMessage): Promise<ChannelDelivery> {
    const none = { sent: 0, failed: 0, removed: 0 };
    if (this.setting.kind !== "on") return none;
    let targets: PushSubscription[];
    try {
      targets = await this.subscriptions.forUser(message.userId);
    } catch (error) {
      this.logger.warn({ err: error, kind: message.kind }, "push subscriptions not read");
      return none;
    }
    if (targets.length === 0) return none;

    const payload = devicePayload(message);
    const topic =
      message.thread !== undefined && TOPIC.test(message.thread) ? message.thread : undefined;
    const outcomes = await Promise.all(
      targets.map(async (target) => this.sendOne(target, payload, topic)),
    );
    const delivery = {
      sent: outcomes.filter((outcome) => outcome === "sent").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
      removed: outcomes.filter((outcome) => outcome === "removed").length,
    };
    this.logger.log({ kind: message.kind, ...delivery }, "web push delivered");
    return delivery;
  }

  private async sendOne(
    subscription: PushSubscription,
    payload: Buffer,
    topic: string | undefined,
  ): Promise<Outcome> {
    const setting = this.setting;
    if (setting.kind !== "on") return "failed";
    // A row kept before the allow-list changed is not pushed to on trust.
    if (pushEndpointProblem(subscription.endpoint) !== null) {
      await this.subscriptions.drop(subscription.id).catch(() => undefined);
      return "removed";
    }
    const service = new URL(subscription.endpoint);
    try {
      const body = encryptPushPayload({
        plaintext: payload,
        userAgentPublicKey: base64UrlDecode(subscription.p256dh),
        authSecret: base64UrlDecode(subscription.auth),
      });
      const response = await this.fetchImpl(subscription.endpoint, {
        method: "POST",
        headers: {
          TTL: String(PUSH_TTL_SECONDS),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          Urgency: "normal",
          Authorization: vapidAuthorization({
            audience: service.origin,
            subject: setting.subject,
            keys: setting.keys,
            expiresAt: Math.floor(Date.now() / 1000) + VAPID_TOKEN_SECONDS,
          }),
          ...(topic === undefined ? {} : { Topic: topic }),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      // Nothing in a push service's answer is read, so it is not buffered.
      await response.body?.cancel().catch(() => undefined);

      if (response.status >= 200 && response.status < 300) {
        await this.subscriptions.delivered(subscription.id);
        return "sent";
      }
      if (response.status === 404 || response.status === 410) {
        await this.subscriptions.drop(subscription.id);
        return "removed";
      }
      this.logger.warn(
        { status: response.status, service: service.hostname },
        "a push service refused a notification",
      );
    } catch (error) {
      this.logger.warn(
        { service: service.hostname, err: error instanceof Error ? error.message : String(error) },
        "a notification did not reach its push service",
      );
    }
    await this.recordFailure(subscription);
    return "failed";
  }

  private async recordFailure(subscription: PushSubscription): Promise<void> {
    try {
      if (subscription.failureCount + 1 >= MAX_PUSH_FAILURES) {
        await this.subscriptions.drop(subscription.id);
        return;
      }
      await this.subscriptions.failed(subscription.id);
    } catch (error) {
      this.logger.warn({ err: error }, "a push failure was not recorded");
    }
  }
}
