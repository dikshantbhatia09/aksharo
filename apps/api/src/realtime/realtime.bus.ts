import { EventEmitter } from "node:events";

import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";

import { RedisService } from "../common/redis/redis.service.js";

import type Redis from "ioredis";

/**
 * Fan-out between API instances.
 *
 * A room lives on whichever instances happen to hold a socket for it, so an event
 * produced on instance A has to reach a subscriber on instance B. Redis pub/sub is
 * the transport; this interface is the seam, so the gateway's own logic can be
 * tested without Redis (see {@link InMemoryRealtimeBus}) and so a later move to
 * Redis Streams is one class.
 *
 * Subscriptions are per *room channel* and reference-counted by the gateway: an
 * instance subscribes when its first socket joins a room and unsubscribes when its
 * last one leaves, rather than pattern-subscribing to everything and filtering
 * locally.
 */
export interface RealtimeBus {
  subscribe(channel: string): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  publish(channel: string, payload: string): Promise<void>;
  /** Register the single delivery handler. Replaces any previous one. */
  onMessage(handler: BusMessageHandler): void;
  close(): Promise<void>;
}

export type BusMessageHandler = (channel: string, payload: string) => void;

/** DI token, so a test module can bind {@link InMemoryRealtimeBus} instead. */
export const REALTIME_BUS = Symbol("REALTIME_BUS");

/** How long a subscribe or publish waits for the connection to come up. */
export const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Bring a lazily-connected ioredis client up before issuing a command on it.
 *
 * `RedisService` builds its client with `lazyConnect: true` (so constructing the
 * module graph does not dial Redis) and `enableOfflineQueue: false` (which is what
 * BullMQ wants of a connection it blocks on). `duplicate()` inherits **both**, so a
 * freshly duplicated subscriber sits in `wait` and its very first `SUBSCRIBE` is
 * not queued until the socket opens — it is rejected outright with
 * `Stream isn't writeable and enableOfflineQueue options is false`. Nothing retries
 * it, so the room is simply never delivered to. That is A08c, reported by A12.
 *
 * Connecting explicitly is the fix. The status dance is because `connect()` rejects
 * when another caller already started one, and two sockets joining the same new
 * room is the normal case, not the exotic one.
 */
async function ensureConnected(client: Redis): Promise<void> {
  // Read through a function: `client.status === "ready"` narrows the union for the
  // rest of the body, and TypeScript has no way to know that an `await` in between
  // is exactly what changes it.
  const ready = (): boolean => client.status === "ready";
  const idle = (): boolean => client.status === "wait" || client.status === "end";

  if (ready()) return;

  if (idle()) {
    // Rejects if someone else got there first; either way we wait for `ready`.
    await client.connect().catch(() => undefined);
  }
  if (ready()) return;

  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error): void => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onReady = (): void => {
      settle();
    };
    const onError = (error: Error): void => {
      settle(error);
    };
    const timer = setTimeout(() => {
      settle(new Error(`Redis did not become ready within ${String(CONNECT_TIMEOUT_MS)} ms`));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    client.on("ready", onReady);
    client.on("error", onError);
    // It may have become ready between the check above and these listeners.
    if (ready()) settle();
  });
}

/**
 * Redis-backed fan-out.
 *
 * The subscriber is a **duplicate** connection: a Redis client in subscriber mode
 * refuses every other command, so it cannot be the shared `RedisService` client
 * that the health probe and BullMQ also use.
 *
 * Both connections are brought up explicitly before a command is issued (see
 * {@link ensureConnected}); ioredis restores the subscriptions itself across a
 * reconnect, so nothing here has to replay them.
 */
@Injectable()
export class RedisRealtimeBus implements RealtimeBus, OnModuleDestroy {
  private readonly logger = new Logger(RedisRealtimeBus.name);
  private subscriber?: Redis;
  private handler?: BusMessageHandler;

  constructor(private readonly redis: RedisService) {}

  private connection(): Redis {
    if (this.subscriber === undefined) {
      this.subscriber = this.redis.client.duplicate();
      this.subscriber.on("error", (error: Error) => {
        // Never fatal: a dropped fan-out degrades realtime to polling, and ioredis
        // resubscribes on reconnect.
        this.logger.warn({ err: error.message }, "realtime subscriber error");
      });
      this.subscriber.on("message", (channel: string, payload: string) => {
        this.handler?.(channel, payload);
      });
    }
    return this.subscriber;
  }

  async subscribe(channel: string): Promise<void> {
    const subscriber = this.connection();
    await ensureConnected(subscriber);
    await subscriber.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    // A connection that never came up holds no subscriptions to drop, and asking
    // it to would fail for the same reason a cold SUBSCRIBE does.
    if (this.subscriber === undefined || this.subscriber.status !== "ready") return;
    await this.subscriber.unsubscribe(channel);
  }

  async publish(channel: string, payload: string): Promise<void> {
    // The shared client is lazy too. It is usually already up — BullMQ and the
    // readiness probe both use it — but an instance whose first Redis traffic is a
    // realtime publish must not silently drop the event.
    await ensureConnected(this.redis.client);
    await this.redis.client.publish(channel, payload);
  }

  onMessage(handler: BusMessageHandler): void {
    this.handler = handler;
    this.connection();
  }

  async close(): Promise<void> {
    if (this.subscriber === undefined) return;
    this.subscriber.disconnect();
    this.subscriber = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/**
 * In-process broker: what {@link InMemoryRealtimeBus} instances share.
 *
 * Two buses on one broker behave exactly like two API instances on one Redis,
 * which is how the fan-out is tested without infrastructure.
 */
export class InMemoryRealtimeBroker {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A room with many subscribers is normal; the default limit of 10 would warn.
    this.emitter.setMaxListeners(0);
  }

  on(channel: string, listener: (payload: string) => void): void {
    this.emitter.on(channel, listener);
  }

  off(channel: string, listener: (payload: string) => void): void {
    this.emitter.off(channel, listener);
  }

  emit(channel: string, payload: string): void {
    this.emitter.emit(channel, payload);
  }
}

/** A {@link RealtimeBus} over an {@link InMemoryRealtimeBroker}. */
export class InMemoryRealtimeBus implements RealtimeBus {
  private handler?: BusMessageHandler;
  private readonly listeners = new Map<string, (payload: string) => void>();

  constructor(private readonly broker: InMemoryRealtimeBroker) {}

  async subscribe(channel: string): Promise<void> {
    if (this.listeners.has(channel)) return;
    const listener = (payload: string): void => {
      this.handler?.(channel, payload);
    };
    this.listeners.set(channel, listener);
    this.broker.on(channel, listener);
  }

  async unsubscribe(channel: string): Promise<void> {
    const listener = this.listeners.get(channel);
    if (listener === undefined) return;
    this.broker.off(channel, listener);
    this.listeners.delete(channel);
  }

  async publish(channel: string, payload: string): Promise<void> {
    this.broker.emit(channel, payload);
  }

  onMessage(handler: BusMessageHandler): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    for (const [channel, listener] of this.listeners) this.broker.off(channel, listener);
    this.listeners.clear();
  }
}
