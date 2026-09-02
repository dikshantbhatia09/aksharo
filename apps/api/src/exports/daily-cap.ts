import { Injectable, Logger } from "@nestjs/common";

import { FREE_DAILY_BROWSER_MANIFEST_CAP } from "./exports.constants.js";
import { RedisService } from "../common/redis/redis.service.js";

/**
 * Bounds how many browser export manifests a Free workspace may issue in a
 * rolling day (brief scope item 5). Browser renders cost no credits, so nothing
 * else in the system meters them — this is the one abuse backstop.
 *
 * A calendar-day bucket (`UTC yyyy-mm-dd`) rather than a true rolling window: it
 * is one `INCR` plus one `EXPIRE`, it self-heals if the key is ever lost, and a
 * day boundary is not a security property worth a sorted-set for. A Redis outage
 * degrades to "uncapped for a moment", never to refusing an export — the same
 * choice `EntitlementService`'s cache makes.
 */
@Injectable()
export class BrowserManifestDailyCap {
  private readonly logger = new Logger(BrowserManifestDailyCap.name);

  constructor(private readonly redis: RedisService) {}

  /** Increments and returns whether the workspace is now over the cap. */
  async recordAndCheck(
    workspaceId: string,
    limit: number = FREE_DAILY_BROWSER_MANIFEST_CAP,
  ): Promise<{ overCap: boolean; count: number }> {
    const key = this.keyFor(workspaceId);
    try {
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 25 * 60 * 60);
      return { overCap: count > limit, count };
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId },
        "daily manifest cap unavailable; not enforcing",
      );
      return { overCap: false, count: 0 };
    }
  }

  private keyFor(workspaceId: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return `exports:daily-browser-manifests:${workspaceId}:${day}`;
  }
}
