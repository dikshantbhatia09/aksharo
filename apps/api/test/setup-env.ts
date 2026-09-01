/**
 * Seed a complete, valid environment for tests before any module reads it.
 *
 * `loadEnv()` is deliberately fail-fast, so tests must supply the whole contract
 * set (CONTRACTS section 1). Values point at the local compose stack but nothing
 * here connects to it: the A01 health test needs no infrastructure.
 *
 * Real environment variables are never overwritten, so `DATABASE_URL=... vitest`
 * still works when a later work package needs a live database.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  // A08: the scheduler's BullMQ worker would dial Redis the moment a Nest app
  // boots. Suites drive scheduled tasks through `ScheduledTasksService.runNow`.
  MONTAJ_SCHEDULER_DISABLED: "1",
  // A08: partition every BullMQ key and realtime channel this suite touches. The
  // pid keeps two suites — or two agents sharing one Redis — from colliding, and
  // the integration suite deletes its own keys when it is done.
  MONTAJ_QUEUE_PREFIX: `montaj-test-${String(process.pid)}`,
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
  process.env[key] ??= value;
}

/**
 * Silence Nest's console logger during tests.
 *
 * Several suites deliberately drive the failure paths (`HttpExceptionFilter`
 * logging a 500, for one), and their stack traces would otherwise scroll past the
 * real results and read like failures. Assertions cover the behaviour; the console
 * output adds nothing.
 */
import { Logger } from "@nestjs/common";

Logger.overrideLogger(false);
