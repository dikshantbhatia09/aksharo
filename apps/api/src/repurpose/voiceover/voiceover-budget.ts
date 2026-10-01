import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { VOICEOVER_ERRORS } from "./voiceover.constants.js";
import { AppException } from "../../common/errors/error-codes.js";
import { redisKeyPrefix } from "../../common/redis/redis-keys.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { utcDay } from "../dubbing/dub-budget.js";

/**
 * A daily rupee limit on voice-overs, across every workspace (2026-10-01).
 *
 * `VOICEOVER_DAILY_BUDGET_INR` (default ₹100) caps what the text-to-speech
 * vendor may be asked to spend in one UTC day - the voice-over twin of
 * `DUB_DAILY_BUDGET_INR` (`../dubbing/dub-budget.ts`), kept separately so a
 * busy day of dubbing can never starve a voice-over or the other way round.
 * A per-day tally in paise under `{prefix}:voiceover:spend:v1:{YYYY-MM-DD}`.
 *
 * As with dubbing it is charged BEFORE the work, at request time, with one Lua
 * script (read, compare, increment), so two requests can never both take the
 * last paise. A request that never reached the vendor gives its paise back; one
 * whose job ran keeps them counted. ₹100 is about 660,000 characters - over
 * two thousand hooks - so in practice it is a runaway guard, not a quota.
 *
 * Redis unreachable means the day's spend cannot be known, and the request is
 * refused (`voiceover/budget_unavailable`): a limit that fails open is not one.
 */

/** `VOICEOVER_DAILY_BUDGET_INR` when it is not set. */
export const DEFAULT_VOICEOVER_DAILY_BUDGET_INR = 100;

const KEY_TTL_SECONDS = 3 * 24 * 60 * 60;

/** KEYS[1] the day's tally; ARGV want, cap, ttl. `{1, total}` charged, `{0, spent}` not. */
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

/** Paise the day may spend, from `VOICEOVER_DAILY_BUDGET_INR`; 0 switches voice-overs off. */
export function voiceoverDailyBudgetPaise(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source["VOICEOVER_DAILY_BUDGET_INR"]?.trim();
  const inr = raw === undefined || raw === "" ? DEFAULT_VOICEOVER_DAILY_BUDGET_INR : Number(raw);
  if (!Number.isFinite(inr) || inr < 0) return DEFAULT_VOICEOVER_DAILY_BUDGET_INR * 100;
  return Math.round(inr * 100);
}

export type VoiceoverBudgetDecision =
  | { readonly ok: true; readonly day: string }
  | { readonly ok: false; readonly day: string; readonly spentPaise: number };

@Injectable()
export class VoiceoverBudget {
  private readonly logger = new Logger(VoiceoverBudget.name);

  /** The cap, read on every call (an operator's switch). A field so a test can set it. */
  capPaise: () => number = () => voiceoverDailyBudgetPaise();

  constructor(private readonly redis: RedisService) {}

  /**
   * Charge `paise` to today's tally if it fits under the cap, atomically.
   * @throws AppException `voiceover/budget_unavailable` (503) when Redis cannot say.
   */
  async reserve(paise: number, now: number = Date.now()): Promise<VoiceoverBudgetDecision> {
    const day = utcDay(now);
    const want = Math.max(0, Math.ceil(paise));
    let answer: unknown;
    try {
      const client = await this.client();
      answer = await client.eval(
        RESERVE_SCRIPT,
        1,
        this.key(day),
        want,
        this.capPaise(),
        KEY_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn({ err: error }, "the voice-over budget could not be read; refusing");
      throw unavailable();
    }
    if (!Array.isArray(answer) || answer.length < 2) throw unavailable();
    const [charged, total] = answer as [unknown, unknown];
    if (Number(charged) === 1) return { ok: true, day };
    return { ok: false, day, spentPaise: Number(total) };
  }

  /** Give back what a request charged and never spent. Best effort (over-counts when wrong). */
  async release(day: string, paise: number): Promise<void> {
    if (paise <= 0) return;
    try {
      const client = await this.client();
      await client.decrby(this.key(day), Math.ceil(paise));
    } catch (error) {
      this.logger.warn({ err: error, day, paise }, "could not give paise back to the budget");
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
    return `${redisKeyPrefix()}:voiceover:spend:v1:${day}`;
  }
}

function unavailable(): AppException {
  return new AppException(
    VOICEOVER_ERRORS.budgetUnavailable,
    "We could not check today's voice-over limit. Try again in a minute.",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}
