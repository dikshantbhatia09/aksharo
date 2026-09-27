import { Injectable, Logger } from "@nestjs/common";

import { redisKeyPrefix } from "../common/redis/redis-keys.js";
import { RedisService } from "../common/redis/redis.service.js";

/**
 * A circuit breaker on YouTube (clips Wave B, 2026-09-27).
 *
 * Every download is a request to YouTube from the one home IP this deployment
 * has. When YouTube answers with its bot check or a 429 (`media/source_blocked`),
 * every other download in that minute gets the same answer - and each one that
 * tries anyway makes the block longer. So one refusal closes the door for all
 * of them: the gate opens for {@link gateDelayMs} (15 minutes, doubling per
 * refusal within {@link SOURCE_GATE_MEMORY_MS}, at most two hours), runs wait
 * instead of failing ("waiting for YouTube, continuing at 14:20"), and when it
 * is due to close ONE fetch goes first (the half-open probe) while the rest keep
 * waiting. A probe that lands closes the gate; one refused opens it again, for
 * longer.
 *
 * State lives in Redis, shared by every API process. Redis being down leaves
 * the gate closed (fetches go ahead, as they did before it existed): a breaker
 * must never become the outage.
 */

/** How long YouTube is left alone after its first refusal. */
export const SOURCE_GATE_BASE_MS = 15 * 60_000;
/** The longest single wait, however many refusals in a row. */
export const SOURCE_GATE_MAX_MS = 2 * 60 * 60_000;
/** A refusal older than this no longer counts toward the next wait's length. */
export const SOURCE_GATE_MEMORY_MS = 6 * 60 * 60_000;
/** How long the one fetch let through a half-open gate holds it. */
export const SOURCE_GATE_PROBE_MS = 15 * 60_000;
/**
 * How many refused fetches one run waits out before it fails as blocked, with
 * "Try again" and "Upload the file instead". Three waits are 15 + 30 + 60
 * minutes: long enough for a temporary block to lift, short enough that a
 * person is not left watching a spinner for a day.
 */
export const MAX_BLOCKED_FETCHES = 3;

/** The job and media reason a refusal by YouTube is reported with. */
export const SOURCE_BLOCKED_REASON = "media/source_blocked";

/** The wait before a fetch is tried again, after `trips` refusals in a row. */
export function gateDelayMs(trips: number): number {
  return Math.min(SOURCE_GATE_MAX_MS, SOURCE_GATE_BASE_MS * 2 ** Math.max(0, trips - 1));
}

export interface SourceGateState {
  /** Until when fetches wait (ms since the epoch); null when the gate is not open. */
  readonly openUntil: number | null;
  /** Refusals in a row, within {@link SOURCE_GATE_MEMORY_MS}; 0 when closed. */
  readonly trips: number;
}

interface Stored {
  readonly trips: number;
  readonly lastTripAt: number;
  readonly openUntil: number;
}

const CLOSED: SourceGateState = { openUntil: null, trips: 0 };

@Injectable()
export class SourceGate {
  private readonly logger = new Logger(SourceGate.name);

  constructor(private readonly redis: RedisService) {}

  /** Where the gate stands at `now`. */
  async state(now: number = Date.now()): Promise<SourceGateState> {
    const stored = await this.read();
    if (stored === null) return CLOSED;
    return { openUntil: stored.openUntil > now ? stored.openUntil : null, trips: stored.trips };
  }

  /**
   * Whether a fetch may start now. Closed: yes. Open: no. Half-open (the wait
   * is over but the last fetch was refused): yes for exactly one caller, which
   * holds the probe for {@link SOURCE_GATE_PROBE_MS}; everyone else waits for
   * its answer ({@link passed} or {@link trip}).
   */
  async mayFetch(now: number = Date.now()): Promise<boolean> {
    const stored = await this.read();
    if (stored === null || stored.trips === 0) return true;
    if (stored.openUntil > now) return false;
    try {
      const client = await this.client();
      const won = await client.set(this.probeKey(), String(now), "PX", SOURCE_GATE_PROBE_MS, "NX");
      return won === "OK";
    } catch (error) {
      this.logger.warn({ err: error }, "source gate probe unavailable; fetching");
      return true;
    }
  }

  /**
   * YouTube refused a fetch: open the gate, for longer each time in a row.
   * @returns until when fetches now wait (ms since the epoch).
   */
  async trip(now: number = Date.now()): Promise<number> {
    const previous = await this.read();
    const trips =
      previous !== null && now - previous.lastTripAt < SOURCE_GATE_MEMORY_MS
        ? previous.trips + 1
        : 1;
    const openUntil = now + gateDelayMs(trips);
    const stored: Stored = { trips, lastTripAt: now, openUntil };
    try {
      const client = await this.client();
      await client.set(
        this.stateKey(),
        JSON.stringify(stored),
        "PX",
        openUntil - now + SOURCE_GATE_MEMORY_MS,
      );
      await client.del(this.probeKey());
      this.logger.warn(
        { trips, openUntil: new Date(openUntil).toISOString() },
        "YouTube refused a download; links wait until the gate closes",
      );
    } catch (error) {
      this.logger.warn({ err: error }, "could not open the source gate; fetches go ahead");
    }
    return openUntil;
  }

  /** A fetch got through: the gate closes and forgets its refusals. */
  async passed(): Promise<void> {
    try {
      const client = await this.client();
      await client.del(this.stateKey(), this.probeKey());
    } catch (error) {
      this.logger.warn({ err: error }, "could not close the source gate");
    }
  }

  private async read(): Promise<Stored | null> {
    try {
      const client = await this.client();
      const raw = await client.get(this.stateKey());
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as Partial<Stored>;
      if (
        typeof parsed.trips !== "number" ||
        typeof parsed.lastTripAt !== "number" ||
        typeof parsed.openUntil !== "number"
      ) {
        return null;
      }
      return { trips: parsed.trips, lastTripAt: parsed.lastTripAt, openUntil: parsed.openUntil };
    } catch (error) {
      this.logger.warn({ err: error }, "source gate unreadable; treated as closed");
      return null;
    }
  }

  private async client(): Promise<RedisService["client"]> {
    const client = this.redis.client;
    if (client.status === "wait" || client.status === "end") {
      // Another caller may be connecting it at this moment; the command then
      // fails on its own and the caller treats the gate as closed.
      await client.connect().catch(() => undefined);
    }
    return client;
  }

  private stateKey(): string {
    return `${redisKeyPrefix()}:source-gate:youtube`;
  }

  private probeKey(): string {
    return `${redisKeyPrefix()}:source-gate:youtube:probe`;
  }
}
