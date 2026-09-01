import { Global, Module } from "@nestjs/common";

import { type Env, loadEnv } from "@montaj/config";

import { loadRepoDotenv } from "./dotenv.js";

/**
 * Injection token for the validated environment.
 *
 * ```ts
 * constructor(@Inject(ENV) private readonly env: Env) {}
 * ```
 *
 * Injecting the whole `Env` rather than reading `process.env` keeps every module
 * testable: a test module supplies its own object with no global mutation.
 */
export const ENV = Symbol("MONTAJ_ENV");

let cached: Env | undefined;

/**
 * Read `.env` (once) and validate it. Throws `EnvValidationError` naming every
 * offending variable, so a misconfigured deploy fails before the port is bound.
 */
export function resolveEnv(): Env {
  if (cached === undefined) {
    loadRepoDotenv();
    cached = loadEnv();
  }
  return cached;
}

/** Test hook: drop the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: resolveEnv }],
  exports: [ENV],
})
export class ConfigModule {}
