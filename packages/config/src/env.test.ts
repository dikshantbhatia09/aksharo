import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_ENV_VARS,
  EnvValidationError,
  REQUIRED_ENV_VARS,
  envSchema,
  loadEnv,
  safeLoadEnv,
} from "./env.js";

// Vitest runs with the package directory as cwd, so the repo root is two up.
const REPO_ROOT = resolve(process.cwd(), "../..");
const ENV_EXAMPLE = resolve(REPO_ROOT, ".env.example");

const PEM_PRIVATE = "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n";
const PEM_PUBLIC = "-----BEGIN PUBLIC KEY-----\\nBBBB\\n-----END PUBLIC KEY-----\\n";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: "postgresql://montaj:montaj@localhost:5432/montaj?schema=public",
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
    JWT_PRIVATE_KEY: PEM_PRIVATE,
    JWT_PUBLIC_KEY: PEM_PUBLIC,
    INTERNAL_CALLBACK_SECRET: "0".repeat(64),
    WEB_ORIGIN: "http://localhost:3000",
    API_ORIGIN: "http://localhost:3001",
    ...overrides,
  };
}

/** Variable names assigned in .env.example, e.g. `FOO=bar` or `FOO="bar"`. */
function namesInEnvExample(): Set<string> {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return names;
}

describe(".env.example (CONTRACTS §1)", () => {
  it("lists every contract variable", () => {
    const present = namesInEnvExample();
    const missing = CONTRACT_ENV_VARS.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  it("is covered by the Zod schema, one key per contract variable", () => {
    const schemaKeys = new Set(Object.keys(envSchema.shape));
    const missing = CONTRACT_ENV_VARS.filter((name) => !schemaKeys.has(name));
    expect(missing).toEqual([]);
    expect(schemaKeys.size).toBe(CONTRACT_ENV_VARS.length);
  });

  it("has no duplicate entries in the contract list", () => {
    expect(new Set(CONTRACT_ENV_VARS).size).toBe(CONTRACT_ENV_VARS.length);
  });
});

describe("loadEnv", () => {
  it("parses a complete local environment", () => {
    const env = loadEnv({ source: validEnv() });
    expect(env.S3_BUCKET_RAW).toBe("montaj-raw");
    expect(env.LLM_PROVIDER).toBe("mock");
    expect(env.GPU_PROVIDER).toBe("none");
    expect(env.FEATURE_FLAGS_JSON).toEqual({});
  });

  it("unescapes \\n inside PEM keys", () => {
    const env = loadEnv({ source: validEnv() });
    expect(env.JWT_PRIVATE_KEY).toContain("\n");
    expect(env.JWT_PRIVATE_KEY.split("\n")[0]).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("fails fast and names every missing required variable", () => {
    const source = validEnv();
    delete (source as Record<string, unknown>)["DATABASE_URL"];
    delete (source as Record<string, unknown>)["INTERNAL_CALLBACK_SECRET"];

    let thrown: unknown;
    try {
      loadEnv({ source });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvValidationError);
    const message = (thrown as EnvValidationError).message;
    expect(message).toContain("DATABASE_URL is missing");
    expect(message).toContain("INTERNAL_CALLBACK_SECRET is missing");
    expect(message).toContain("Copy .env.example to .env");
    expect((thrown as EnvValidationError).problems).toHaveLength(2);
  });

  it("reports every required variable when the environment is empty", () => {
    const result = safeLoadEnv({ source: {} });
    expect(result.success).toBe(false);
    if (result.success) return;
    for (const name of REQUIRED_ENV_VARS) {
      expect(result.error.message).toContain(name);
    }
  });

  it("explains an invalid value instead of just rejecting it", () => {
    const result = safeLoadEnv({ source: validEnv({ DATABASE_URL: "mysql://nope" }) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("DATABASE_URL: DATABASE_URL must be a postgres://");
  });

  it("rejects a short callback secret", () => {
    const result = safeLoadEnv({ source: validEnv({ INTERNAL_CALLBACK_SECRET: "too-short" }) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("at least 32 characters");
  });

  it("rejects a non-PEM JWT key", () => {
    const result = safeLoadEnv({ source: validEnv({ JWT_PUBLIC_KEY: "not-a-key" }) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("JWT_PUBLIC_KEY must be a PEM block");
  });

  it("treats optional third-party credentials as undefined when blank", () => {
    const env = loadEnv({ source: validEnv({ SENTRY_DSN: "", RAZORPAY_KEY_ID: "  " }) });
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.RAZORPAY_KEY_ID).toBeUndefined();
  });

  it("parses FEATURE_FLAGS_JSON and rejects non-objects", () => {
    const env = loadEnv({ source: validEnv({ FEATURE_FLAGS_JSON: '{"newEditor":true}' }) });
    expect(env.FEATURE_FLAGS_JSON).toEqual({ newEditor: true });

    const bad = safeLoadEnv({ source: validEnv({ FEATURE_FLAGS_JSON: "[1,2]" }) });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown LLM provider", () => {
    const result = safeLoadEnv({ source: validEnv({ LLM_PROVIDER: "gemini" }) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("LLM_PROVIDER");
  });
});
