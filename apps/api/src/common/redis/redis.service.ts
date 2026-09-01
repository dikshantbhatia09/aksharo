import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

import type { Env } from "@montaj/config";

import { ENV } from "../../config/config.module.js";

/**
 * The shared Redis connection.
 *
 * A03 only needs it for the readiness probe, but the connection belongs here
 * rather than in the health module: A08 puts BullMQ on the same instance and must
 * not open a second pool. `lazyConnect` keeps `pnpm test` from dialling Redis
 * merely because the module graph was constructed, and `maxRetriesPerRequest:
 * null` is what BullMQ requires of a connection it will block on.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      // A readiness probe must fail fast, not hang until the request times out.
      connectTimeout: 2_000,
      retryStrategy: (times) => Math.min(times * 200, 2_000),
    });
    // Without a listener, a connection error becomes an unhandled 'error' event
    // and takes the process down.
    this.client.on("error", () => {
      /* surfaced by the readiness probe */
    });
  }

  /** Round trip, connecting on first use. Throws when Redis is unreachable. */
  async ping(): Promise<void> {
    if (this.client.status === "wait" || this.client.status === "end") {
      await this.client.connect();
    }
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== "end") {
      this.client.disconnect();
    }
  }
}
