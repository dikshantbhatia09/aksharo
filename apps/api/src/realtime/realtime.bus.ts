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

/**
 * Redis-backed fan-out.
 *
 * The subscriber is a **duplicate** connection: a Redis client in subscriber mode
 * refuses every other command, so it cannot be the shared `RedisService` client
 * that the health probe and BullMQ also use.
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
    await this.connection().subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    if (this.subscriber === undefined) return;
    await this.subscriber.unsubscribe(channel);
  }

  async publish(channel: string, payload: string): Promise<void> {
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
