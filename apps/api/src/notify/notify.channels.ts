import type { NotifyKind } from "./notify.kinds.js";

/**
 * Channels that reach a person's devices directly (2026-09-29), beside the two
 * `notify` always had: the bell (`notifications` rows) and email (the queue).
 *
 * Web Push is the first (`push/push.channel.ts`). Another — WhatsApp, an
 * Android app's own push — is one more class that implements
 * {@link NotificationChannel} and one more entry in the
 * {@link NOTIFICATION_CHANNELS} provider (`notify.module.ts`): `NotifyService`
 * hands every device kind (`DEVICE_KINDS`) to each channel, and a channel
 * decides for itself whether the person can be reached on it.
 *
 * The message is already rendered — in the person's language, from the same
 * catalogue as the email (`templates/messages.*.ts`, `push` strings) — so a
 * channel only transports it.
 */
export interface DeviceMessage {
  readonly userId: string;
  readonly kind: NotifyKind;
  readonly title: string;
  readonly body: string;
  /** Where opening it goes: a URL on the web app. */
  readonly url: string;
  /**
   * Groups messages about one thing (a run): a newer one replaces an older
   * one still on screen, or still waiting at the push service for an offline
   * device, rather than stacking up.
   */
  readonly thread?: string;
}

/** What one delivery did, for the log line and for the tests. */
export interface ChannelDelivery {
  readonly sent: number;
  readonly failed: number;
  /** Destinations the service said are gone for good, and that were forgotten. */
  readonly removed: number;
}

export interface NotificationChannel {
  readonly name: string;
  /**
   * Send `message` to every destination this person has on this channel.
   * Must not throw for a delivery reason: a notification is a side effect of
   * work that is already done, and one unreachable phone must not fail it.
   */
  deliver(message: DeviceMessage): Promise<ChannelDelivery>;
}

/** The injection token for the list of device channels. */
export const NOTIFICATION_CHANNELS = Symbol("NOTIFICATION_CHANNELS");
