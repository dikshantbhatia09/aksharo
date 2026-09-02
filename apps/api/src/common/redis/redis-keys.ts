/**
 * The namespace every Redis key this API writes lives under (A23b).
 *
 * Five modules keep their own key builders — `auth.constants.ts`,
 * `rate-limit.service.ts`, `notify.constants.ts`, `account.constants.ts` and
 * `workspaces.constants.ts` — and every one of them used to hard-code `montaj:`.
 * That was fine while the only thing sharing a Redis was a developer's own stack.
 * It stopped being fine when the API test suite passed sixteen e2e files: A23a
 * gives each suite a logical Redis database of its own, Redis ships with sixteen,
 * and the seventeenth suite onwards shared one with a sibling — where a
 * `montaj:*` sweep between tests takes the sibling's keys with it. A21 watched
 * `auth.e2e-spec.ts` lose its dev-outbox messages exactly that way.
 *
 * So the namespace is a value, not a literal, and a test run gives each suite its
 * own. Logical databases are still used when there are enough to go round, but
 * they are now a second separator rather than the only one.
 *
 * Read from `process.env` rather than the validated `Env`, for the same reason
 * {@link import("../../jobs/jobs.config.js").queuePrefix} is: `docs/CONTRACTS.md`
 * section 1 is the frozen list of *product* configuration, and this is deployment
 * and test naming. Unset — which is every deployment — the keys are exactly the
 * names they have always been.
 *
 * BullMQ structures and realtime pub/sub channels are NOT covered here. They are
 * named by `MONTAJ_QUEUE_PREFIX` (`jobs.config.ts`), because `apps/worker-media`,
 * `apps/render` and `apps/worker-ai` have to agree with the API on them; that
 * variable is already per-suite in tests, so those keys are already isolated.
 */

/** What the prefix is when nothing sets it: the names every deployment uses. */
export const DEFAULT_REDIS_KEY_PREFIX = "montaj";

/** Environment variable that overrides it. Test-only in practice. */
export const REDIS_KEY_PREFIX_ENV = "MONTAJ_REDIS_PREFIX";

/**
 * The prefix every `montaj:`-style key is built from.
 *
 * Called at key-construction time rather than cached, so a suite that changes the
 * variable and rebuilds its module graph sees the change.
 */
export function redisKeyPrefix(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source[REDIS_KEY_PREFIX_ENV]?.trim();
  return raw === undefined || raw === "" ? DEFAULT_REDIS_KEY_PREFIX : raw;
}
