/**
 * Seed a complete, valid environment for tests before any module reads it.
 *
 * `loadEnv()` is deliberately fail-fast, so tests must supply the whole contract
 * set (CONTRACTS section 1). Values point at the local compose stack but nothing
 * here connects to it: the A01 health test needs no infrastructure.
 *
 * Real environment variables are never overwritten, so `DATABASE_URL=... vitest`
 * still works when a later work package needs a live database. The two exceptions
 * are A23a's: `MONTAJ_QUEUE_PREFIX` and `REDIS_URL` are ASSIGNED, at the bottom of
 * this file, from the slice of the run's infrastructure this suite owns — an
 * inherited value pointing at a developer's own stack is precisely what the
 * isolation exists to override.
 */
import { Logger } from "@nestjs/common";

import { applySuiteEnvironment } from "./suite-context.js";

const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  // A08: the scheduler's BullMQ worker would dial Redis the moment a Nest app
  // boots. Suites drive scheduled tasks through `ScheduledTasksService.runNow`.
  MONTAJ_SCHEDULER_DISABLED: "1",
  // A08: partition every BullMQ key and realtime channel this suite touches.
  // A23a replaces this default with the suite's own prefix below; the default
  // still matters for a spec run under some other Vitest config.
  MONTAJ_QUEUE_PREFIX: `montaj-test-${String(process.pid)}`,
  // A25: same reasoning as the scheduler. Most suites boot the app with a
  // substituted Redis, and a BullMQ `Worker` on a stub would throw at bootstrap.
  // `test/auth-harness.ts` — the one suite with a real Redis that needs mail
  // actually delivered — turns it back on for itself.
  NOTIFY_WORKER_ENABLED: "0",
  MAIL_PROVIDER: "dev",
  AUTH_DEV_AUTO_VERIFY: "0",
  MAIL_FROM: "",
  SMTP_URL: "",
  DATABASE_URL: "postgresql://montaj:montaj@localhost:5432/montaj_test?schema=public",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "ap-south-1",
  S3_BUCKET_RAW: "montaj-raw",
  S3_ACCESS_KEY: "montaj-local",
  S3_SECRET_KEY: "montaj-local-secret",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_DERIVED: "montaj-derived",
  R2_ACCESS_KEY: "montaj-local",
  R2_SECRET_KEY: "montaj-local-secret",
  JWT_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\ntest-only-not-a-real-key\\n-----END PRIVATE KEY-----\\n",
  JWT_PUBLIC_KEY:
    "-----BEGIN PUBLIC KEY-----\\ntest-only-not-a-real-key\\n-----END PUBLIC KEY-----\\n",
  INTERNAL_CALLBACK_SECRET: "test-callback-secret-at-least-32-characters-long",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:3001",
  LLM_PROVIDER: "mock",
  GPU_PROVIDER: "none",
  FEATURE_FLAGS_JSON: "{}",
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  process.env[key] ??= value;
}

/**
 * A23a: point this worker at the corner of the run's infrastructure it owns.
 *
 * Runs here, in a setup file, rather than in a harness, because
 * `jobs.e2e-spec.ts` and `dlq.e2e-spec.ts` read `MONTAJ_QUEUE_PREFIX` at module
 * scope — long before any `beforeAll` hook could have set it.
 */
applySuiteEnvironment();

/**
 * Silence Nest's console logger during tests.
 *
 * Several suites deliberately drive the failure paths (`HttpExceptionFilter`
 * logging a 500, for one), and their stack traces would otherwise scroll past the
 * real results and read like failures. Assertions cover the behaviour; the console
 * output adds nothing.
 */
Logger.overrideLogger(false);
