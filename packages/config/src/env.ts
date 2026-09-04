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
  "R2_PUBLIC_ENDPOINT",
  "JWT_PRIVATE_KEY",
  "JWT_PUBLIC_KEY",
  "INTERNAL_CALLBACK_SECRET",
  "INTERNAL_CALLBACK_SECRET_NEXT",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "AUTH_DEV_AUTO_VERIFY",
  "LICENSE_SIGNING_KID",
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
  "LLM_BASE_URL",
  "LLM_MODEL",
  "GPU_PROVIDER",
  "GPU_PROVIDER_URL",
  "GPU_PROVIDER_TOKEN",
  "SENTRY_DSN",
  "POSTHOG_KEY",
  "FEATURE_FLAGS_JSON",
  "MAIL_PROVIDER",
  "MAIL_FROM",
  "SMTP_URL",
  "MAIL_SNS_TOPIC_ARN",
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
// eslint-disable-next-line security/detect-unsafe-regex -- reviewed and timed against adversarial input -- linear, no nested unbounded quantifiers -- not exponential (see M06 report)
const MAIL_FROM_PATTERN = /^(?:[^<>]{1,64}\s)?<?[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+>?$/;

const pemKey = (name: string) =>
  nonEmpty(name).refine(
    (value) => value.includes("-----BEGIN") && value.includes("-----END"),
    `${name} must be a PEM block (newlines may be escaped as \\n)`,
  );

/** Unescape `\n` so a single-line PEM from a .env file becomes a real key. */
const unescapeNewlines = (value: string): string => value.replace(/\\n/g, "\n");

export const LLM_PROVIDERS = ["anthropic", "openai", "ollama", "mock"] as const;
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
  // The origin BROWSERS fetch derived media from (presigned GETs for the proxy
  // video, waveform, thumbs). Falls back to R2_ENDPOINT when unset. In dev behind
  // an HTTPS tunnel this must be the tunnel; in production it is the CDN domain in
  // front of the derived bucket. Internal writers keep using R2_ENDPOINT.
  // `optionalSecret()` (not a bare `.optional()`) because `.env.example` ships this
  // key BLANK — an empty value is how "unset, fall back to R2_ENDPOINT" is spelled,
  // and a bare optional would reject `R2_PUBLIC_ENDPOINT=` outright, so every copy
  // of `.env.example` would refuse to boot. Same shape as `GPU_PROVIDER_URL`.
  R2_PUBLIC_ENDPOINT: optionalSecret().refine(
    (value) => value === undefined || /^https?:\/\/[^\s]+$/.test(value),
    "R2_PUBLIC_ENDPOINT must be an http(s) URL, for example https://media.example.com",
  ),
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
  AUTH_DEV_AUTO_VERIFY: z
    .enum(["0", "1"])
    .default("0")
    .transform((value) => value === "1"),
  // Identifies which key pair signed a licence-key offline payload (B08). Reuses
  // JWT_PRIVATE_KEY/JWT_PUBLIC_KEY rather than a third secret; bump this when the
  // key pair rotates so a cached offline snapshot can be told apart from a fresh one.
  LICENSE_SIGNING_KID: z.string().trim().min(1).max(32).default("k1"),

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
  // M20 free-stack mode: a local, OpenAI-compatible Ollama server. No key
  // needed — `LLM_PROVIDER=ollama` is selectable without ANTHROPIC_API_KEY or
  // OPENAI_API_KEY ever being set. Defaults match a stock local Ollama
  // install (`ollama pull qwen2.5:3b`), so a bare `LLM_PROVIDER=ollama` with
  // both of these left empty still works out of the box.
  LLM_BASE_URL: z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value === undefined || value === "" ? "http://127.0.0.1:11434/v1" : value,
    )
    .refine((value) => /^https?:\/\/[^\s]+$/.test(value), "LLM_BASE_URL must be an http(s) URL"),
  LLM_MODEL: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? "qwen2.5:3b" : value)),

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
  // The topic the SES bounce/complaint feed is expected on. Optional, because a
  // signature from AWS is already the authentication; setting it narrows that to
  // one topic, so a signed message from any other one is refused.
  MAIL_SNS_TOPIC_ARN: optionalSecret().refine(
    (value) => value === undefined || /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[\w-]+$/.test(value),
    "MAIL_SNS_TOPIC_ARN must be an SNS topic ARN, e.g. arn:aws:sns:ap-south-1:123456789012:aksharo-mail-events",
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
 * A mail provider that talks to a real server needs an envelope sender, and SMTP
 * needs somewhere to send it. `dev` needs neither, which is why a developer can boot
 * with nothing configured. The remaining rules keep the development sign-up bypass
 * (`AUTH_DEV_AUTO_VERIFY`) fail-closed: it is refused outright unless the dev outbox
 * was chosen deliberately, and refused always under NODE_ENV=production.
 *
 * `source` is the raw environment the values came from, so a rule can tell "set to
 * the default" apart from "explicitly requested"; it defaults to `process.env` so a
 * caller cannot skip a security rule by omitting it.
 */
export function crossFieldProblems(
  env: Env,
  source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string[] {
  const problems: string[] = [];
  if (env.MAIL_PROVIDER !== "dev" && env.MAIL_FROM === undefined) {
    problems.push(`MAIL_FROM is required when MAIL_PROVIDER is "${env.MAIL_PROVIDER}"`);
  }
  if (env.MAIL_PROVIDER === "smtp" && env.SMTP_URL === undefined) {
    problems.push('SMTP_URL is required when MAIL_PROVIDER is "smtp"');
  }
  if (env.AUTH_DEV_AUTO_VERIFY) {
    // A sign-up that skips mailbox proof is not merely a convenience: `emailVerifiedAt`
    // is what authorises claiming a pending workspace invitation, so an unverified
    // address that counts as verified can collect another tenant's grant. Every unsafe
    // combination therefore refuses to boot rather than being silently ignored — an
    // ignored flag stays armed in a parameter store until an unrelated config change
    // turns it live, with no code change and no review.
    if (env.MAIL_PROVIDER !== "dev") {
      problems.push(
        'AUTH_DEV_AUTO_VERIFY=1 requires MAIL_PROVIDER="dev" ' +
          `(it is "${env.MAIL_PROVIDER}"): a real mail transport means real sign-ups`,
      );
    } else if (source["MAIL_PROVIDER"] === undefined) {
      // MAIL_PROVIDER defaults to "dev", so an unset value must never be read as
      // permission to bypass verification; the dev outbox has to be chosen on purpose.
      problems.push(
        'AUTH_DEV_AUTO_VERIFY=1 requires MAIL_PROVIDER to be set explicitly to "dev" ' +
          "(it is unset and only defaulting to dev)",
      );
    }
    if (source["NODE_ENV"] === "production") {
      problems.push("AUTH_DEV_AUTO_VERIFY=1 is never valid when NODE_ENV=production");
    }
  }
  // A mixed-content object store can never work: the page is HTTPS, the browser
  // refuses plain-HTTP media/uploads before dispatch, and the only symptom is a
  // console CSP line. Refuse to boot instead — this exact drift shipped a build
  // where no video ever played (FIX-01, audit 2026-09-04).
  if (env.WEB_ORIGIN.startsWith("https://")) {
    const derivedPublic = env.R2_PUBLIC_ENDPOINT ?? env.R2_ENDPOINT;
    if (derivedPublic.startsWith("http://")) {
      problems.push(
        "R2_PUBLIC_ENDPOINT (or R2_ENDPOINT as its fallback) is plain http " +
          `("${derivedPublic}") while WEB_ORIGIN is https — browsers will block ` +
          "every derived media object. Point R2_PUBLIC_ENDPOINT at an https origin.",
      );
    }
    if (env.S3_ENDPOINT.startsWith("http://")) {
      problems.push(
        `S3_ENDPOINT is plain http ("${env.S3_ENDPOINT}") while WEB_ORIGIN is https ` +
          "— browser uploads will be blocked. Use an https origin.",
      );
    }
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
    const problems = crossFieldProblems(result.data, source);
    if (problems.length > 0) throw new EnvValidationError(problems);
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : "(environment)";
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
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
