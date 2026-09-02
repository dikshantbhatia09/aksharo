/**
 * Environment schema for every variable in docs/CONTRACTS.md §1.
 *
 * `loadEnv()` fails fast with a readable, aggregated message so a missing secret
 * is a startup error rather than a null-pointer three layers into a request.
 * No value is ever logged back; only variable names appear in error output.
 */

import { z } from "zod";

/**
 * The frozen contract list (CONTRACTS §1), in contract order. Tests assert that
 * `.env.example` and {@link envSchema} both cover exactly these names.
 */
export const CONTRACT_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET_RAW",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "R2_ENDPOINT",
  "R2_BUCKET_DERIVED",
  "R2_ACCESS_KEY",
  "R2_SECRET_KEY",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "INTERNAL_CALLBACK_SECRET",
  "INTERNAL_CALLBACK_SECRET_NEXT",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "WEB_ORIGIN",
  "API_ORIGIN",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "SARVAM_API_KEY",
  "ELEVENLABS_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GPU_PROVIDER",
  "GPU_PROVIDER_URL",
  "GPU_PROVIDER_TOKEN",
  "SENTRY_DSN",
  "POSTHOG_KEY",
  "FEATURE_FLAGS_JSON",
  "MAIL_PROVIDER",
  "MAIL_FROM",
  "SMTP_URL",
] as const;

export type ContractEnvVar = (typeof CONTRACT_ENV_VARS)[number];

/** Variables that must be present and non-empty for any service to boot. */
export const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET_RAW",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "R2_ENDPOINT",
  "R2_BUCKET_DERIVED",
  "R2_ACCESS_KEY",
  "R2_SECRET_KEY",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "INTERNAL_CALLBACK_SECRET",
  "WEB_ORIGIN",
  "API_ORIGIN",
] as const satisfies readonly ContractEnvVar[];

const nonEmpty = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} must not be empty`);

const optionalSecret = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value));

const httpOrigin = (name: string) =>
  nonEmpty(name).refine(
    (value) => /^https?:\/\/[^\s]+$/.test(value),
    `${name} must be an http(s) URL, for example http://localhost:3000`,
  );

/**
 * `local@domain` or `Display Name <local@domain>`.
 *
 * Deliberately loose — RFC 5322 is not worth re-implementing here and the real
 * check is SES refusing an unverified identity — but strict enough to catch the
 * two mistakes that actually happen: a bare domain, and a display name with no
 * angle brackets.
 */
const MAIL_FROM_PATTERN = /^(?:[^<>]{1,64}\s)?<?[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+>?$/;

const pemKey = (name: string) =>
  nonEmpty(name).refine(
    (value) => value.includes("-----BEGIN") && value.includes("-----END"),
    `${name} must be a PEM block (newlines may be escaped as \\n)`,
  );

/** Unescape `\n` so a single-line PEM from a .env file becomes a real key. */
const unescapeNewlines = (value: string): string => value.replace(/\\n/g, "\n");

export const LLM_PROVIDERS = ["anthropic", "openai", "mock"] as const;
export const MAIL_PROVIDERS = ["ses", "smtp", "dev"] as const;
export type MailProviderName = (typeof MAIL_PROVIDERS)[number];

export const GPU_PROVIDERS = ["runpod", "modal", "replicate", "none"] as const;

export const envSchema = z.object({
  // --- Datastores ---
  DATABASE_URL: nonEmpty("DATABASE_URL").refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must be a postgres:// or postgresql:// connection string",
  ),
  REDIS_URL: nonEmpty("REDIS_URL").refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    "REDIS_URL must be a redis:// or rediss:// connection string",
  ),

  // --- Raw object storage (AWS S3 ap-south-1 in production, MinIO locally) ---
  S3_ENDPOINT: httpOrigin("S3_ENDPOINT"),
  S3_REGION: nonEmpty("S3_REGION"),
  S3_BUCKET_RAW: nonEmpty("S3_BUCKET_RAW"),
  S3_ACCESS_KEY: nonEmpty("S3_ACCESS_KEY"),
  S3_SECRET_KEY: nonEmpty("S3_SECRET_KEY"),

  // --- Derived object storage (Cloudflare R2 in production, MinIO locally) ---
  R2_ENDPOINT: httpOrigin("R2_ENDPOINT"),
  R2_BUCKET_DERIVED: nonEmpty("R2_BUCKET_DERIVED"),
  R2_ACCESS_KEY: nonEmpty("R2_ACCESS_KEY"),
  R2_SECRET_KEY: nonEmpty("R2_SECRET_KEY"),

  // --- Auth ---
  JWT_PRIVATE_KEY: pemKey("JWT_PRIVATE_KEY").transform(unescapeNewlines),
  JWT_PUBLIC_KEY: pemKey("JWT_PUBLIC_KEY").transform(unescapeNewlines),
  INTERNAL_CALLBACK_SECRET: nonEmpty("INTERNAL_CALLBACK_SECRET").refine(
    (value) => value.length >= 32,
    "INTERNAL_CALLBACK_SECRET must be at least 32 characters (32 random bytes, hex-encoded)",
  ),
  // Rotation: set the incoming secret here, roll every worker onto it, then
  // promote it to INTERNAL_CALLBACK_SECRET and clear this. The API accepts a
  // signature from either while both are set, so no callback is lost mid-roll.
  INTERNAL_CALLBACK_SECRET_NEXT: optionalSecret().refine(
    (value) => value === undefined || value.length >= 32,
    "INTERNAL_CALLBACK_SECRET_NEXT must be at least 32 characters (32 random bytes, hex-encoded)",
  ),
  GOOGLE_OAUTH_CLIENT_ID: optionalSecret(),
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecret(),

  // --- Origins ---
  WEB_ORIGIN: httpOrigin("WEB_ORIGIN"),
  API_ORIGIN: httpOrigin("API_ORIGIN"),

  // --- Payments ---
  RAZORPAY_KEY_ID: optionalSecret(),
  RAZORPAY_KEY_SECRET: optionalSecret(),
  RAZORPAY_WEBHOOK_SECRET: optionalSecret(),

  // --- Speech providers ---
  SARVAM_API_KEY: optionalSecret(),
  ELEVENLABS_API_KEY: optionalSecret(),
  ASSEMBLYAI_API_KEY: optionalSecret(),

  // --- LLM ---
  LLM_PROVIDER: z.enum(LLM_PROVIDERS).default("mock"),
  ANTHROPIC_API_KEY: optionalSecret(),
  OPENAI_API_KEY: optionalSecret(),

  // --- GPU (A09; the endpoint the serverless pool is invoked at) ---
  GPU_PROVIDER: z.enum(GPU_PROVIDERS).default("none"),
  GPU_PROVIDER_URL: optionalSecret().refine(
    (value) => value === undefined || /^https?:\/\/[^\s]+$/.test(value),
    "GPU_PROVIDER_URL must be an http(s) URL",
  ),
  GPU_PROVIDER_TOKEN: optionalSecret(),

  // --- Observability (optional; empty disables the integration) ---
  SENTRY_DSN: optionalSecret(),
  POSTHOG_KEY: optionalSecret(),

  // --- Transactional mail (A25; delivery lives in apps/api/src/notify) ---
  // `ses` takes its credentials from the pod's IRSA role and its region from
  // S3_REGION, so there is no mail access key anywhere in the contract.
  MAIL_PROVIDER: z.enum(MAIL_PROVIDERS).default("dev"),
  MAIL_FROM: optionalSecret().refine(
    (value) => value === undefined || MAIL_FROM_PATTERN.test(value),
    "MAIL_FROM must be an address, optionally with a display name: `Aksharo <hello@aksharo.ai>`",
  ),
  SMTP_URL: optionalSecret().refine(
    (value) => value === undefined || /^smtps?:\/\/[^\s]+$/.test(value),
    "SMTP_URL must be an smtp:// or smtps:// URL",
  ),

  // --- Feature flags ---
  FEATURE_FLAGS_JSON: z
    .string()
    .default("{}")
    .transform((value, ctx): Record<string, unknown> => {
      const text = value.trim() === "" ? "{}" : value.trim();
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          ctx.addIssue({
            code: "custom",
            message: "FEATURE_FLAGS_JSON must be a JSON object, for example {}",
          });
          return {};
        }
        return parsed as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: "custom", message: "FEATURE_FLAGS_JSON must be valid JSON" });
        return {};
      }
    }),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown by {@link loadEnv}; carries one line per offending variable. */
export class EnvValidationError extends Error {
  public override readonly name = "EnvValidationError";

  constructor(public readonly problems: readonly string[]) {
    super(
      [
        `Invalid environment: ${problems.length} problem${problems.length === 1 ? "" : "s"}.`,
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "Copy .env.example to .env and fill in the missing values.",
        "See docs/CONTRACTS.md §1 for the full list.",
      ].join("\n"),
    );
  }
}

export interface LoadEnvOptions {
  /** Where to read from. Defaults to `process.env`. */
  readonly source?: Record<string, string | undefined>;
}

/**
 * Rules that span more than one variable, checked after the shape is known.
 *
 * They live here rather than in a `.superRefine()` on {@link envSchema} because
 * that would turn the schema into an effect wrapper and `envSchema.shape` — which
 * the contract test walks to prove every CONTRACTS section 1 variable has a key —
 * would stop existing.
 *
 * Only one rule so far: a mail provider that talks to a real server needs an
 * envelope sender, and SMTP needs somewhere to send it. `dev` needs neither, which
 * is why a developer can boot with nothing configured.
 */
export function crossFieldProblems(env: Env): string[] {
  const problems: string[] = [];
  if (env.MAIL_PROVIDER !== "dev" && env.MAIL_FROM === undefined) {
    problems.push(`MAIL_FROM is required when MAIL_PROVIDER is "${env.MAIL_PROVIDER}"`);
  }
  if (env.MAIL_PROVIDER === "smtp" && env.SMTP_URL === undefined) {
    problems.push('SMTP_URL is required when MAIL_PROVIDER is "smtp"');
  }
  return problems;
}

/**
 * Parse and validate the environment, or throw {@link EnvValidationError} with a
 * message that names every offending variable. Values are never echoed.
 */
export function loadEnv(options: LoadEnvOptions = {}): Env {
  const source = options.source ?? (process.env as Record<string, string | undefined>);
  const result = envSchema.safeParse(source);

  if (result.success) {
    const problems = crossFieldProblems(result.data);
    if (problems.length > 0) throw new EnvValidationError(problems);
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : "(environment)";
    const raw = source[variable];
    if (raw === undefined) return `${variable} is missing`;
    if (raw.trim() === "") return `${variable} is empty`;
    return `${variable}: ${issue.message}`;
  });

  throw new EnvValidationError([...new Set(problems)].sort());
}

/** Non-throwing variant for tooling that wants to report several problems at once. */
export function safeLoadEnv(
  options: LoadEnvOptions = {},
): { success: true; env: Env } | { success: false; error: EnvValidationError } {
  try {
    return { success: true, env: loadEnv(options) };
  } catch (error) {
    if (error instanceof EnvValidationError) return { success: false, error };
    throw error;
  }
}
