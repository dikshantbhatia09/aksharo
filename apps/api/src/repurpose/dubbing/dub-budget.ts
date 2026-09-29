import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { DUB_ERRORS } from "./dubs.constants.js";
import { AppException } from "../../common/errors/error-codes.js";
import { redisKeyPrefix } from "../../common/redis/redis-keys.js";
import { RedisService } from "../../common/redis/redis.service.js";

/**
 * A daily rupee limit on dubbing, across every workspace (2026-10-04).
 *
 * `DUB_DAILY_BUDGET_INR` (default ₹500) caps what the dubbing vendor may be
 * asked to spend in one UTC day. It is the dubbing twin of the language
 * model's `LLM_DAILY_BUDGET_INR` (`worker_ai/llm/budget.py`): a per-day tally
 * in the Redis BullMQ runs on, in paise, under
 * `{prefix}:dub:spend:v1:{YYYY-MM-DD}` (`montaj:` in every deployment).
 *
 * Unlike the model's, it is charged BEFORE the work, at request time: a dub is
 * one vendor job of known length and languages, so its whole price is known
 * up front, and a request the day cannot afford is refused rather than
 * started. The check and the charge are one Lua script - read, compare,
 * increment - so two requests at the same moment can never both take the last
 * rupees. A request that never reached the vendor (refused, failed or
 * cancelled before its vendor job started) gives its paise back; one whose
 * vendor job started keeps them counted, whether or not the vendor billed,
 * because a limit should over-count rather than under-count.
 *
 * Redis unreachable means the day's spend cannot be known, and the request is
 * refused (`dub/budget_unavailable`): a limit that fails open is not a limit.
 */

/** `DUB_DAILY_BUDGET_INR` when it is not set. */
export const DEFAULT_DUB_DAILY_BUDGET_INR = 500;

/** Long enough to read yesterday's figure in the morning, short enough to go. */
const KEY_TTL_SECONDS = 3 * 24 * 60 * 60;

/**
 * KEYS[1] the day's tally; ARGV[1] paise asked for, ARGV[2] the cap, ARGV[3]
 * the key's lifetime. Answers `{1, total}` when charged, `{0, spent}` when not.
 */
const RESERVE_SCRIPT = `
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local want = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if spent + want > cap then
  return {0, spent}
end
local total = redis.call('INCRBY', KEYS[1], want)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, total}
`;

/** Paise the day may spend, from `DUB_DAILY_BUDGET_INR`; 0 switches dubbing off. */
export function dubDailyBudgetPaise(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source["DUB_DAILY_BUDGET_INR"]?.trim();
  const inr = raw === undefined || raw === "" ? DEFAULT_DUB_DAILY_BUDGET_INR : Number(raw);
  if (!Number.isFinite(inr) || inr < 0) return DEFAULT_DUB_DAILY_BUDGET_INR * 100;
  return Math.round(inr * 100);
}

/** The UTC day a charge is counted on: `2026-10-04`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type BudgetDecision =
  | { readonly ok: true; readonly day: string; readonly spentPaise: number }
  | {
      readonly ok: false;
      readonly day: string;
      readonly spentPaise: number;
      readonly capPaise: number;
    };

@Injectable()
export class DubBudget {
  private readonly logger = new Logger(DubBudget.name);

  /** The cap, read on every call (an operator's switch). A field so a test can set it. */
  capPaise: () => number = () => dubDailyBudgetPaise();

  constructor(private readonly redis: RedisService) {}

  /**
   * Charge `paise` to today's tally if it fits under the cap, atomically.
   * @throws AppException `dub/budget_unavailable` (503) when Redis cannot say.
   */
  async reserve(paise: number, now: number = Date.now()): Promise<BudgetDecision> {
    const day = utcDay(now);
    const cap = this.capPaise();
    const want = Math.max(0, Math.ceil(paise));
    let answer: unknown;
    try {
      const client = await this.client();
      answer = await client.eval(RESERVE_SCRIPT, 1, this.key(day), want, cap, KEY_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error }, "the dubbing budget could not be read; refusing");
      throw unavailable();
    }
    if (!Array.isArray(answer) || answer.length < 2) throw unavailable();
    const [charged, total] = answer as [unknown, unknown];
    const spentPaise = Number(total);
    if (Number(charged) === 1) return { ok: true, day, spentPaise };
    return { ok: false, day, spentPaise, capPaise: cap };
  }

  /**
   * Give back what a request charged and never spent. Best effort: a failure
   * leaves the day over-counted, which is the safe way to be wrong.
   */
  async release(day: string, paise: number): Promise<void> {
    if (paise <= 0) return;
    try {
      const client = await this.client();
      await client.decrby(this.key(day), Math.ceil(paise));
    } catch (error) {
      this.logger.warn(
        { err: error, day, paise },
        "could not give paise back to the dubbing budget",
      );
    }
  }

  private async client(): Promise<RedisService["client"]> {
    const client = this.redis.client;
    if (client.status === "wait" || client.status === "end") {
      await client.connect().catch(() => undefined);
    }
    return client;
  }

  private key(day: string): string {
    return `${redisKeyPrefix()}:dub:spend:v1:${day}`;
  }
}

function unavailable(): AppException {
  return new AppException(
    DUB_ERRORS.budgetUnavailable,
    "We could not check today's dubbing limit. Try again in a minute.",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
