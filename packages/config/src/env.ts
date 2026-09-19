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
  "S3_PUBLIC_ENDPOINT",
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
  // S3_ACCESS_KEY / S3_SECRET_KEY are deliberately NOT here: blank means "use
  // the AWS default credential chain" (IRSA). See the schema below.
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
  // Optional since P0-09: blank means "use the AWS default credential chain",
  // which is how IRSA / EKS Pod Identity works — the pod is handed a projected
  // token and a role ARN, and the SDK finds them on its own. Requiring a
  // non-empty key forced a static, long-lived access key into every process
  // that touches raw media, which is exactly the credential IRSA exists to
  // remove. `S3ObjectStore` omits the `credentials` option entirely when these
  // are blank; passing empty strings would silently disable the chain.
  //
  // R2 below stays required: Cloudflare has no IAM equivalent, so the derived
  // store genuinely needs a static key pair.
  S3_ACCESS_KEY: optionalSecret(),
  S3_SECRET_KEY: optionalSecret(),
  // The origin BROWSERS PUT/GET raw media through (presigned multipart uploads,
  // CONTRACTS §6 — the upload never goes through the API). Falls back to
  // S3_ENDPOINT when unset. Internal head/tag/delete calls keep using
  // S3_ENDPOINT directly — same split as R2_PUBLIC_ENDPOINT below, added after
  // production's internal stat calls were found round-tripping through a
  // public tunnel and hitting transient failures (2026-09-06).
  S3_PUBLIC_ENDPOINT: optionalSecret().refine(
    (value) => value === undefined || /^https?:\/\/[^\s]+$/.test(value),
    "S3_PUBLIC_ENDPOINT must be an http(s) URL, for example https://uploads.example.com",
  ),

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

/** Every variable is optional here; what a given service must have is below. */
export type PartialEnv = Partial<Env>;

export const SERVICE_NAMES = ["api", "web", "worker-media", "worker-ai", "render"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/**
 * What each service must have to start, as opposed to what the *product*
 * contract lists.
 *
 * `loadEnv()` has one required set — {@link REQUIRED_ENV_VARS} — and every
 * service used it, so `apps/render` and `apps/worker-media` refused to boot
 * without `DATABASE_URL` and both JWT keys. Neither opens a database
 * connection or mints a token; `grep -oh "env\.[A-Z_]*"` over either source
 * tree lists only Redis, the two object stores, the callback secret and
 * `API_ORIGIN`.
 *
 * That was not merely untidy. The Helm chart has to supply whatever a service
 * validates, so the shared secret had to carry the database URL and the signing
 * key to every worker pod — which is most of the blast radius the per-component
 * secret split was meant to remove (launch-readiness P0-09). A narrower required
 * set here is what lets `externalSecrets.shared` shrink.
 *
 * Adding a variable to a service's list is a deliberate widening of what that
 * workload is trusted with. Do it in the same change as the chart entry.
 */
export const SERVICE_REQUIRED_ENV_VARS = {
  /** The API is the only service that reaches every subsystem. */
  api: REQUIRED_ENV_VARS,
  /** The web server renders and proxies; it holds no credential of its own. */
  web: ["WEB_ORIGIN", "API_ORIGIN"],
  /** Queue in, object storage out, signed callback home. */
  "worker-media": [
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET_RAW",
    "R2_ENDPOINT",
    "R2_BUCKET_DERIVED",
    "R2_ACCESS_KEY",
    "R2_SECRET_KEY",
    "INTERNAL_CALLBACK_SECRET",
    "API_ORIGIN",
  ],
  /** Same as worker-media; its provider keys are optional and checked at use. */
  "worker-ai": [
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET_RAW",
    "R2_ENDPOINT",
    "R2_BUCKET_DERIVED",
    "R2_ACCESS_KEY",
    "R2_SECRET_KEY",
    "INTERNAL_CALLBACK_SECRET",
    "API_ORIGIN",
  ],
  /** Same shape again: read raw media, write derived, report back. */
  render: [
    "REDIS_URL",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET_RAW",
    "R2_ENDPOINT",
    "R2_BUCKET_DERIVED",
    "R2_ACCESS_KEY",
    "R2_SECRET_KEY",
    "INTERNAL_CALLBACK_SECRET",
    "API_ORIGIN",
  ],
} as const satisfies Readonly<Record<ServiceName, readonly ContractEnvVar[]>>;

/** Variables `loadEnv` demands that this service does not. */
type RelaxedFor<S extends ServiceName> = Exclude<
  (typeof REQUIRED_ENV_VARS)[number],
  (typeof SERVICE_REQUIRED_ENV_VARS)[S][number]
>;

/** {@link Env} with the variables this service does not need made optional. */
export type ServiceEnv<S extends ServiceName> = Omit<Env, RelaxedFor<S>> &
  Partial<Pick<Env, RelaxedFor<S>>>;

/**
 * The schema for one service: {@link envSchema} with the variables that service
 * does not need relaxed to optional.
 *
 * `.extend()` overrides only the named keys, so every other field keeps its
 * default, refinement and transform. Only members of {@link REQUIRED_ENV_VARS}
 * are ever relaxed — everything else is already optional or defaulted, and
 * making those optional would drop defaults the cross-field rules read.
 */
function serviceSchema(service: ServiceName) {
  // eslint-disable-next-line security/detect-object-injection -- internal enumerated key, not attacker-controlled
  const needed = new Set<string>(SERVICE_REQUIRED_ENV_VARS[service]);
  const relaxed: Record<string, z.ZodTypeAny> = {};
  for (const name of REQUIRED_ENV_VARS) {
    if (needed.has(name)) continue;
    // eslint-disable-next-line security/detect-object-injection -- iterating a frozen internal list, not attacker input
    relaxed[name] = envSchema.shape[name].optional();
  }
  return envSchema.extend(relaxed);
}

const SERVICE_SCHEMAS = new Map<ServiceName, ReturnType<typeof serviceSchema>>();

/**
 * Parse and validate only what `service` actually needs.
 *
 * Use this from a worker's entry point; the API keeps {@link loadEnv}, which
 * demands the whole contract. A variable outside the service's required set is
 * still parsed and still validated *if present* — this narrows what is
 * mandatory, never what is checked.
 */
export function loadServiceEnv<S extends ServiceName>(
  service: S,
  options: LoadEnvOptions = {},
): ServiceEnv<S> {
  const source = options.source ?? (process.env as Record<string, string | undefined>);

  let schema = SERVICE_SCHEMAS.get(service);
  if (schema === undefined) {
    schema = serviceSchema(service);
    SERVICE_SCHEMAS.set(service, schema);
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(describeIssues(result.error.issues, source));
  }

  const problems = crossFieldProblems(result.data as PartialEnv, source);
  if (problems.length > 0) throw new EnvValidationError(problems);

  return result.data as ServiceEnv<S>;
}


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
  env: PartialEnv,
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
  problems.push(...productionProblems(env, source));

  // A mixed-content object store can never work: the page is HTTPS, the browser
  // refuses plain-HTTP media/uploads before dispatch, and the only symptom is a
  // console CSP line. Refuse to boot instead — this exact drift shipped a build
  // where no video ever played (FIX-01, audit 2026-09-04).
  // `WEB_ORIGIN` is absent for a service that does not need it
  // (`loadServiceEnv`), so this rule is conditional on having one at all.
  if (env.WEB_ORIGIN !== undefined && env.WEB_ORIGIN.startsWith("https://")) {
    const derivedPublic = env.R2_PUBLIC_ENDPOINT ?? env.R2_ENDPOINT;
    if (derivedPublic !== undefined && derivedPublic.startsWith("http://")) {
      problems.push(
        "R2_PUBLIC_ENDPOINT (or R2_ENDPOINT as its fallback) is plain http " +
          `("${derivedPublic}") while WEB_ORIGIN is https — browsers will block ` +
          "every derived media object. Point R2_PUBLIC_ENDPOINT at an https origin.",
      );
    }
    const rawPublic = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
    if (rawPublic !== undefined && rawPublic.startsWith("http://")) {
      problems.push(
        `S3_PUBLIC_ENDPOINT (or S3_ENDPOINT as its fallback) is plain http ` +
          `("${rawPublic}") while WEB_ORIGIN is https — browser uploads will be ` +
          "blocked. Point S3_PUBLIC_ENDPOINT at an https origin.",
      );
    }
  }
  return problems;
}

/**
 * Flags (`FEATURE_FLAGS_JSON`) that gate a surface whose production path is not
 * finished, or that record a deliberate decision to run without a control.
 */
export const PRODUCTION_GATE_FLAGS = {
  /** Checkout, subscriptions and refunds. Off until live Razorpay keys exist. */
  checkout: "billing.checkout",
  /** Partner music/SFX catalogues. Off until the licence snapshots are real. */
  partnerCatalogue: "assets.partnerCatalogue",
  /** "Yes, we know there is no error tracking." A decision, not an oversight. */
  errorTrackingOptOut: "observability.errorTrackingOptOut",
} as const;

/**
 * Rules that only apply under `NODE_ENV=production`.
 *
 * Every one of these is a development default that is harmless locally and
 * silently wrong in front of customers. They are startup errors rather than
 * warnings because each had, or would have had, no visible symptom until a user
 * hit it: a verification email that goes to a Redis list nobody reads, an AI
 * feature returning canned text that looks like a real answer, a checkout that
 * marks an order paid without a payment. A log line at boot is not a control —
 * nobody reads the boot log of a service that started (launch-readiness P0-06,
 * P0-12, P0-13).
 *
 * `source` rather than `env` wherever "unset" and "set to the default" must be
 * told apart, for the reason {@link crossFieldProblems} explains.
 */
function productionProblems(
  env: PartialEnv,
  source: Record<string, string | undefined>,
): string[] {
  if (source["NODE_ENV"] !== "production") return [];
  const problems: string[] = [];
  const flags = env.FEATURE_FLAGS_JSON ?? {};

  if (env.MAIL_PROVIDER === "dev") {
    problems.push(
      'MAIL_PROVIDER="dev" is not valid under NODE_ENV=production: the dev outbox is a ' +
        "Redis list, so verification, magic-link and password-reset mail would never " +
        'reach anyone. Set MAIL_PROVIDER="ses" (or "smtp") and MAIL_FROM.',
    );
  }

  if (env.LLM_PROVIDER === "mock") {
    problems.push(
      'LLM_PROVIDER="mock" is not valid under NODE_ENV=production: prompted edits, ' +
        "transcript cleanup and the other LLM passes would return canned output that " +
        "a customer cannot tell from a real answer.",
    );
  }

  if (flags[PRODUCTION_GATE_FLAGS.checkout] === true) {
    const razorpay = [env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET];
    if (razorpay.some((value) => value === undefined || value === "")) {
      problems.push(
        `${PRODUCTION_GATE_FLAGS.checkout}=true under NODE_ENV=production requires ` +
          "RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET. Without " +
          "them billing falls back to the fake provider, which settles orders and " +
          "grants credits without any payment ever being taken.",
      );
    }
  }

  if (flags[PRODUCTION_GATE_FLAGS.partnerCatalogue] === true) {
    problems.push(
      `${PRODUCTION_GATE_FLAGS.partnerCatalogue}=true is not valid under ` +
        "NODE_ENV=production: the per-track licence snapshot the catalogue is supposed " +
        "to write with every use is still a TODO, so there would be no record of what " +
        "was licensed to whom.",
    );
  }

  if (env.SENTRY_DSN === undefined || env.SENTRY_DSN === "") {
    if (flags[PRODUCTION_GATE_FLAGS.errorTrackingOptOut] !== true) {
      problems.push(
        "SENTRY_DSN is empty under NODE_ENV=production: nothing would report an " +
          "unhandled error, so the first sign of a broken release is a customer saying " +
          `so. Set it, or record the decision with ${PRODUCTION_GATE_FLAGS.errorTrackingOptOut}=true ` +
          "in FEATURE_FLAGS_JSON.",
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

  throw new EnvValidationError(describeIssues(result.error.issues, source));
}

/** One readable line per offending variable. Values are never echoed. */
function describeIssues(
  issues: readonly z.core.$ZodIssue[],
  source: Record<string, string | undefined>,
): string[] {
  const problems = issues.map((issue) => {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : "(environment)";
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const raw = source[variable];
    if (raw === undefined) return `${variable} is missing`;
    if (raw.trim() === "") return `${variable} is empty`;
    return `${variable}: ${issue.message}`;
  });
  return [...new Set(problems)].sort();
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
