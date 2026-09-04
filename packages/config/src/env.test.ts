import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTRACT_ENV_VARS,
  EnvValidationError,
  MAIL_PROVIDERS,
  REQUIRED_ENV_VARS,
  crossFieldProblems,
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

  it("parses AUTH_DEV_AUTO_VERIFY as an opt-in 0/1 switch", () => {
    expect(loadEnv({ source: validEnv() }).AUTH_DEV_AUTO_VERIFY).toBe(false);
    expect(
      loadEnv({ source: validEnv({ AUTH_DEV_AUTO_VERIFY: "1", MAIL_PROVIDER: "dev" }) })
        .AUTH_DEV_AUTO_VERIFY,
    ).toBe(true);
    expect(() => loadEnv({ source: validEnv({ AUTH_DEV_AUTO_VERIFY: "true" }) })).toThrow(
      EnvValidationError,
    );
  });

  // The sign-up bypass is an authorisation control, not a convenience: a verified
  // address can claim workspace invitations sent to it. Every unsafe combination has
  // to stop the process at boot, because a flag that is merely ignored stays armed in
  // a parameter store until an unrelated config change makes it live.
  describe("AUTH_DEV_AUTO_VERIFY refuses to boot when it could be unsafe", () => {
    it("rejects a real mail transport instead of silently ignoring the flag", () => {
      expect(() =>
        loadEnv({
          source: validEnv({
            AUTH_DEV_AUTO_VERIFY: "1",
            MAIL_PROVIDER: "ses",
            MAIL_FROM: "hi@aksharo.ai",
          }),
        }),
      ).toThrow(/AUTH_DEV_AUTO_VERIFY=1 requires MAIL_PROVIDER="dev"/);
    });

    it("rejects a MAIL_PROVIDER that is merely defaulting to dev", () => {
      // MAIL_PROVIDER defaults to "dev", so a production deployment that simply never
      // set it must not inherit permission to skip mailbox proof.
      expect(() => loadEnv({ source: validEnv({ AUTH_DEV_AUTO_VERIFY: "1" }) })).toThrow(
        /MAIL_PROVIDER to be set explicitly/,
      );
    });

    it("rejects NODE_ENV=production even with the dev outbox selected", () => {
      expect(() =>
        loadEnv({
          source: validEnv({
            AUTH_DEV_AUTO_VERIFY: "1",
            MAIL_PROVIDER: "dev",
            NODE_ENV: "production",
          }),
        }),
      ).toThrow(/never valid when NODE_ENV=production/);
    });

    it("leaves a boot with the flag off completely unaffected", () => {
      expect(
        loadEnv({ source: validEnv({ MAIL_PROVIDER: "ses", MAIL_FROM: "hi@aksharo.ai" }) })
          .AUTH_DEV_AUTO_VERIFY,
      ).toBe(false);
    });
  });

  describe("mixed-content object stores refuse to boot (FIX-01)", () => {
    const HTTPS_WEB = {
      WEB_ORIGIN: "https://app.example.com",
      API_ORIGIN: "https://api.example.com",
    };

    it("rejects a plain-http derived store behind an https web origin", () => {
      expect(() => loadEnv({ source: validEnv({ ...HTTPS_WEB }) })).toThrow(/derived media object/);
    });

    it("accepts it once R2_PUBLIC_ENDPOINT is https", () => {
      const env = loadEnv({
        source: validEnv({
          ...HTTPS_WEB,
          // The sibling rule above covers the upload store; an https origin here
          // isolates this case to the derived-store rule it is about.
          S3_ENDPOINT: "https://uploads.example.com",
          R2_PUBLIC_ENDPOINT: "https://media.example.com",
        }),
      });
      expect(env.R2_PUBLIC_ENDPOINT).toBe("https://media.example.com");
    });

    it("stays quiet for an all-http local dev setup", () => {
      expect(loadEnv({ source: validEnv() }).R2_PUBLIC_ENDPOINT).toBeUndefined();
    });
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

describe("transactional mail (CONTRACTS §1, added after A04)", () => {
  it("defaults to the development outbox, which needs nothing configured", () => {
    const env = loadEnv({ source: validEnv() });
    expect(env.MAIL_PROVIDER).toBe("dev");
    expect(env.MAIL_FROM).toBeUndefined();
    expect(env.SMTP_URL).toBeUndefined();
  });

  it("offers exactly the three transports", () => {
    expect([...MAIL_PROVIDERS]).toEqual(["ses", "smtp", "dev"]);
    expect(() => loadEnv({ source: validEnv({ MAIL_PROVIDER: "sendgrid" }) })).toThrow(
      EnvValidationError,
    );
  });

  /**
   * SES authenticates with the pod's IRSA role, so there is deliberately no mail
   * key in the contract — but it still needs a verified sender, and SMTP still
   * needs somewhere to connect.
   */
  it("requires an envelope sender for a real transport, and a URL for SMTP", () => {
    expect(() => loadEnv({ source: validEnv({ MAIL_PROVIDER: "ses" }) })).toThrow(
      /MAIL_FROM is required/,
    );
    expect(() =>
      loadEnv({ source: validEnv({ MAIL_PROVIDER: "smtp", MAIL_FROM: "hi@aksharo.ai" }) }),
    ).toThrow(/SMTP_URL is required/);

    const env = loadEnv({
      source: validEnv({
        MAIL_PROVIDER: "smtp",
        MAIL_FROM: "Aksharo <hi@aksharo.ai>",
        SMTP_URL: "smtp://localhost:1025",
      }),
    });
    expect(env.MAIL_FROM).toBe("Aksharo <hi@aksharo.ai>");
    expect(crossFieldProblems(env)).toEqual([]);
  });

  it("takes an optional SNS topic ARN and rejects anything that is not one", () => {
    const arn = "arn:aws:sns:ap-south-1:123456789012:aksharo-mail-events";
    expect(loadEnv({ source: validEnv() }).MAIL_SNS_TOPIC_ARN).toBeUndefined();
    expect(loadEnv({ source: validEnv({ MAIL_SNS_TOPIC_ARN: arn }) }).MAIL_SNS_TOPIC_ARN).toBe(arn);
    for (const bad of [
      "aksharo-mail-events",
      "arn:aws:sqs:ap-south-1:123456789012:q",
      arn.replace("123456789012", "12"),
    ]) {
      expect(() => loadEnv({ source: validEnv({ MAIL_SNS_TOPIC_ARN: bad }) }), bad).toThrow(
        EnvValidationError,
      );
    }
  });

  it("rejects a sender that is not an address and a URL that is not SMTP", () => {
    expect(() =>
      loadEnv({ source: validEnv({ MAIL_PROVIDER: "ses", MAIL_FROM: "aksharo.ai" }) }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv({
        source: validEnv({
          MAIL_PROVIDER: "smtp",
          MAIL_FROM: "hi@aksharo.ai",
          SMTP_URL: "https://localhost:1025",
        }),
      }),
    ).toThrow(EnvValidationError);
  });
});

describe("the serverless GPU endpoint (CONTRACTS §1, added after A09)", () => {
  it("is optional, because the local default is GPU_PROVIDER=none", () => {
    const env = loadEnv({ source: validEnv() });
    expect(env.GPU_PROVIDER).toBe("none");
    expect(env.GPU_PROVIDER_URL).toBeUndefined();
    expect(env.GPU_PROVIDER_TOKEN).toBeUndefined();
  });

  it("takes an http(s) endpoint and a token, and refuses anything else as a URL", () => {
    const env = loadEnv({
      source: validEnv({
        GPU_PROVIDER: "runpod",
        GPU_PROVIDER_URL: "https://api.runpod.ai/v2/abc/run",
        GPU_PROVIDER_TOKEN: "rp-token",
      }),
    });
    expect(env.GPU_PROVIDER_URL).toBe("https://api.runpod.ai/v2/abc/run");
    expect(env.GPU_PROVIDER_TOKEN).toBe("rp-token");

    expect(() => loadEnv({ source: validEnv({ GPU_PROVIDER_URL: "api.runpod.ai" }) })).toThrow(
      EnvValidationError,
    );
  });
});
