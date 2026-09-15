import { z } from "zod";

/**
 * Publishing contracts, version 1 (REP-005).
 *
 * Schema-only and inert: no client, no adapter, no queue registration lives here.
 * Two rules shape almost every schema in this file.
 *
 * 1. **Aksharo never holds a provider secret.** A connection is an opaque external
 *    integration id plus display metadata (ADR 0002 §3). `assertNoSecretFields`
 *    turns that from a convention into a parse-time failure.
 * 2. **A publish is at-most-once per attempt, plus reconciliation.** The dispatch
 *    payload therefore carries an id and nothing else: copy, settings, media URL
 *    and integration id are read from the frozen row at dispatch time, so a job
 *    that sat in Redis for an hour cannot post yesterday's text to an account that
 *    has since been disconnected.
 */
export const PUBLISHING_SCHEMA_VERSION = 1 as const;

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeTextSchema = z.string().trim().min(1).max(240);

/**
 * An HTTPS URL, and only that.
 *
 * `z.url()` accepts any parseable URL, which includes `javascript:alert(1)` and a
 * `data:` payload of arbitrary size. Every URL in this file either arrives from a
 * provider response or is rendered as a link a person clicks — an avatar, a public
 * post URL — so a scheme check is the difference between a contract and a wish.
 * `http:` is excluded too: these are public endpoints on services that all require
 * TLS, and accepting plaintext would let a downgrade pass validation.
 */
const HttpsUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => value.toLowerCase().startsWith("https://"), "URL must use HTTPS.");

/**
 * Canonical Aksharo provider ids — the destination matrix of master plan §12.5.
 *
 * These are OUR names, not the publishing service's: the adapter maps between the
 * two, so a rename inside that service is one mapping change rather than a
 * migration of every stored row.
 */
export const PUBLISH_PROVIDERS = [
  "instagram",
  "facebook",
  "threads",
  "youtube",
  "linkedin",
  "tiktok",
  "x",
  "snapchat",
  "whatsapp",
] as const;
export const ProviderSchema = z.enum(PUBLISH_PROVIDERS);

export const PUBLISH_MODES = ["direct", "schedule", "mobile_handoff", "download_only"] as const;
export const PublishModeSchema = z.enum(PUBLISH_MODES);

export const PUBLISH_TARGET_STATUSES = [
  "draft",
  "validating",
  "ready",
  "submitted",
  "processing",
  "published",
  "scheduled",
  "action_required",
  "failed_retryable",
  "failed_permanent",
  "cancelled",
] as const;
export const PublishTargetStatusSchema = z.enum(PUBLISH_TARGET_STATUSES);

/** Terminal states. A target in one of these is never dispatched again. */
export const TERMINAL_TARGET_STATUSES = [
  "published",
  "failed_permanent",
  "cancelled",
] as const satisfies readonly (typeof PUBLISH_TARGET_STATUSES)[number][];

export function isTerminalTargetStatus(status: string): boolean {
  return (TERMINAL_TARGET_STATUSES as readonly string[]).includes(status);
}

export const CONNECTION_STATUSES = ["connected", "attention", "disconnected"] as const;
export const ConnectionStatusSchema = z.enum(CONNECTION_STATUSES);

/**
 * Substrings that would mean a provider secret had reached Aksharo.
 *
 * Checked at parse time on connection payloads, because the realistic way a token
 * arrives is not a deliberate decision — it is an upstream response spread into an
 * object with one extra field nobody looked at.
 */
const SECRET_FIELD_MARKERS = [
  "token",
  "secret",
  "password",
  "credential",
  "refresh",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "authorization",
] as const;

/** True when any key of `value`, at any depth, looks like a secret. */
export function findSecretFields(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSecretFields(entry, [...path, String(index)]));
  }
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalised = key.toLowerCase();
    if (SECRET_FIELD_MARKERS.some((marker) => normalised.includes(marker))) {
      found.push([...path, key].join("."));
    }
    found.push(...findSecretFields(child, [...path, key]));
  }
  return found;
}

/** Live capability of ONE connected account, read back from the provider. */
export const ConnectionCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  /** What this account may actually do today — not what the product supports. */
  modes: z.array(PublishModeSchema).min(1).max(4),
  maxDurationMs: z.int().positive().max(86_400_000).nullable(),
  minDurationMs: z.int().nonnegative().max(86_400_000).nullable(),
  maxBytes: z.int().positive().max(10_000_000_000).nullable(),
  aspects: z.array(z.enum(["9:16", "4:5", "1:1", "16:9"])).max(4),
  maxTitleLength: z.int().positive().max(1_000).nullable(),
  maxBodyLength: z.int().positive().max(10_000).nullable(),
  maxHashtags: z.int().nonnegative().max(100).nullable(),
  /** Provider minimum lead time and horizon for a scheduled post (§12.6). */
  scheduleMinLeadMs: z.int().nonnegative().max(86_400_000).nullable(),
  scheduleMaxHorizonMs: z.int().positive().max(31_536_000_000).nullable(),
  /** An unaudited app may only post privately; the UI must say so before confirm. */
  privateOnly: z.boolean(),
  checkedAt: z.iso.datetime(),
});

/**
 * A connected account as Aksharo may know it.
 *
 * `.check()` rejects any extra secret-shaped key even though the object is strict,
 * because a strict object only fails on keys it does not know — the guard exists
 * for the day somebody ADDS one.
 */
export const ChannelConnectionViewSchema = z
  .strictObject({
    schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
    id: UlidSchema,
    workspaceId: UlidSchema,
    provider: ProviderSchema,
    /** Opaque id from the publishing service. Useless without its secrets. */
    externalIntegrationId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().max(200).nullable(),
    username: z.string().trim().max(200).nullable(),
    avatarUrl: z.union([HttpsUrlSchema, z.null()]),
    status: ConnectionStatusSchema,
    capabilities: ConnectionCapabilitiesSchema.nullable(),
    lastVerifiedAt: z.union([z.iso.datetime(), z.null()]),
  })
  .superRefine((value, context) => {
    for (const field of findSecretFields(value)) {
      context.addIssue({
        code: "custom",
        path: field.split("."),
        message: "A provider secret must never reach Aksharo (ADR 0002).",
      });
    }
  });

/** Post text for one target. Provider limits are checked against the profile. */
export const PostCopySchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  /** Some surfaces have a title (YouTube), some do not (Instagram). */
  title: z.string().trim().max(1_000).nullable(),
  body: z.string().max(10_000),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).max(100),
  /** The copy's language, which may differ from the burned-in caption language. */
  locale: z.string().trim().min(2).max(64),
});

/**
 * Provider-specific post settings, discriminated so an unknown provider cannot
 * smuggle arbitrary JSON into a request. Every branch is deliberately small:
 * a setting is added when a provider's documented behaviour needs it, with the
 * profile that proves it.
 */
export const ProviderSettingsSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("instagram"),
    surface: z.enum(["reel", "feed", "story"]),
    shareToFeed: z.boolean(),
    collaborators: z.array(z.string().trim().max(100)).max(3),
  }),
  z.strictObject({
    provider: z.literal("facebook"),
    surface: z.enum(["reel", "feed", "story"]),
    pageId: z.string().trim().max(100).nullable(),
  }),
  z.strictObject({
    provider: z.literal("threads"),
    surface: z.literal("post"),
  }),
  z.strictObject({
    provider: z.literal("youtube"),
    surface: z.enum(["short", "video"]),
    /** An unaudited API project can only publish privately — see capabilities. */
    privacy: z.enum(["private", "unlisted", "public"]),
    madeForKids: z.boolean(),
    categoryId: z.string().trim().max(10).nullable(),
  }),
  z.strictObject({
    provider: z.literal("linkedin"),
    surface: z.enum(["member", "organization"]),
    organizationUrn: z.string().trim().max(200).nullable(),
    visibility: z.enum(["public", "connections"]),
  }),
  z.strictObject({
    provider: z.literal("tiktok"),
    surface: z.literal("video"),
    privacy: z.enum(["private", "friends", "public"]),
    /** TikTok requires explicit creator consent per post, not once per account. */
    disclosesBrandedContent: z.boolean(),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
  }),
  z.strictObject({
    provider: z.literal("x"),
    surface: z.literal("post"),
    replySettings: z.enum(["everyone", "following", "mentioned"]),
  }),
  z.strictObject({
    provider: z.literal("snapchat"),
    surface: z.enum(["story", "spotlight"]),
  }),
  z.strictObject({
    provider: z.literal("whatsapp"),
    surface: z.literal("status"),
  }),
]);

/**
 * Safe error classes. A provider's own message is never rendered to a user; it is
 * mapped onto one of these, and only the class decides what happens next.
 *
 * `uncertain` is the important one: it means we do not know whether the provider
 * accepted the post, so the ONLY legal next step is reconciliation (§4.3).
 */
export const PUBLISH_ERROR_CODES = [
  "publishing/validation_failed",
  "publishing/permission_missing",
  "publishing/token_expired",
  "publishing/account_disconnected",
  "publishing/rate_limited",
  "publishing/media_rejected",
  "publishing/content_rejected",
  "publishing/duplicate_content",
  "publishing/provider_unavailable",
  "publishing/uncertain_outcome",
  "publishing/artifact_stale",
  "publishing/not_approved",
] as const;
export const PublishErrorCodeSchema = z.enum(PUBLISH_ERROR_CODES);

/** What the dispatcher is allowed to do next, per error code. */
export const PUBLISH_ERROR_BEHAVIOUR = Object.freeze({
  "publishing/validation_failed": "permanent",
  "publishing/permission_missing": "permanent",
  "publishing/token_expired": "needs_user",
  "publishing/account_disconnected": "needs_user",
  "publishing/rate_limited": "retry_after",
  "publishing/media_rejected": "permanent",
  "publishing/content_rejected": "permanent",
  "publishing/duplicate_content": "permanent",
  "publishing/provider_unavailable": "retryable",
  "publishing/uncertain_outcome": "reconcile_first",
  "publishing/artifact_stale": "permanent",
  "publishing/not_approved": "permanent",
} as const satisfies Record<(typeof PUBLISH_ERROR_CODES)[number], string>);

export const PublishErrorSchema = z
  .strictObject({
    code: PublishErrorCodeSchema,
    /** Plain language, already safe to render. Never a provider payload. */
    message: SafeTextSchema,
    /** Present only for `publishing/rate_limited`. */
    retryAfterMs: z.union([z.int().nonnegative().max(86_400_000), z.null()]),
  })
  .superRefine((value, context) => {
    const behaviour = PUBLISH_ERROR_BEHAVIOUR[value.code];
    if (behaviour === "retry_after" && value.retryAfterMs === null) {
      context.addIssue({
        code: "custom",
        path: ["retryAfterMs"],
        message: "A rate-limit error must carry the provider's Retry-After.",
      });
    }
    if (behaviour !== "retry_after" && value.retryAfterMs !== null) {
      context.addIssue({
        code: "custom",
        path: ["retryAfterMs"],
        message: "Only a rate-limit error carries Retry-After.",
      });
    }
  });

/** One destination as the UI sees it. */
export const PublishTargetViewSchema = z
  .strictObject({
    schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
    id: UlidSchema,
    batchId: UlidSchema,
    clipId: UlidSchema,
    variantId: UlidSchema,
    connectionId: UlidSchema.nullable(),
    provider: ProviderSchema,
    publishMode: PublishModeSchema,
    scheduledAt: z.union([z.iso.datetime(), z.null()]),
    status: PublishTargetStatusSchema,
    copy: PostCopySchema,
    settings: ProviderSettingsSchema,
    artifactFingerprint: Sha256Schema,
    externalUrl: z.union([HttpsUrlSchema, z.null()]),
    lastError: PublishErrorSchema.nullable(),
    attemptNo: z.int().nonnegative().max(1_000),
  })
  .superRefine((value, context) => {
    if ((value.publishMode === "schedule") !== (value.scheduledAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "Only a scheduled target carries an instant.",
      });
    }
    if (value.settings.provider !== value.provider) {
      context.addIssue({
        code: "custom",
        path: ["settings", "provider"],
        message: "Settings belong to a different provider.",
      });
    }
    if (value.status === "published" && value.externalUrl === null) {
      context.addIssue({
        code: "custom",
        path: ["externalUrl"],
        message: "A published target must show where it was published.",
      });
    }
  });

export const PUBLISH_BATCH_MODES = ["now", "mixed", "scheduled"] as const;
export const PublishBatchModeSchema = z.enum(PUBLISH_BATCH_MODES);

export const PUBLISH_BATCH_STATUSES = [
  "pending",
  "publishing",
  "partially_published",
  "published",
  "failed",
  "cancelled",
] as const;
export const PublishBatchStatusSchema = z.enum(PUBLISH_BATCH_STATUSES);

/** One user confirmation and every destination it covers. */
export const PublishBatchViewSchema = z
  .strictObject({
    schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
    id: UlidSchema,
    runId: UlidSchema,
    mode: PublishBatchModeSchema,
    /** IANA zone, shown beside every time the user sees (§12.6). */
    timezone: z.string().trim().min(3).max(64),
    status: PublishBatchStatusSchema,
    confirmedAt: z.iso.datetime(),
    targets: z.array(PublishTargetViewSchema).min(1).max(100),
  })
  .superRefine((value, context) => {
    const scheduled = value.targets.filter((target) => target.publishMode === "schedule").length;
    const expected =
      scheduled === 0 ? "now" : scheduled === value.targets.length ? "scheduled" : "mixed";
    if (value.mode !== expected) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Batch mode does not describe its targets.",
      });
    }
  });

/**
 * `publish.dispatch@1`.
 *
 * Deliberately one id. Everything else is read from the frozen target row under
 * its workspace at dispatch time (§8.6), so a long-queued job cannot post stale
 * copy, and no signed media URL or integration id is left sitting in Redis.
 */
export const PublishDispatchPayloadSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  publishTargetId: UlidSchema,
  attemptNo: z.int().positive().max(1_000),
});

export const PublishDispatchResultSchema = z
  .strictObject({
    schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
    publishTargetId: UlidSchema,
    status: PublishTargetStatusSchema,
    /** Persisted BEFORE any further provider call (§12.4 step 6). */
    externalPostId: z.union([z.string().trim().min(1).max(200), z.null()]),
    externalUrl: z.union([HttpsUrlSchema, z.null()]),
    error: PublishErrorSchema.nullable(),
  })
  .superRefine((value, context) => {
    if ((value.error !== null) !== value.status.startsWith("failed")) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only a failed dispatch carries an error.",
      });
    }
    if (value.status === "published" && value.externalPostId === null) {
      context.addIssue({
        code: "custom",
        path: ["externalPostId"],
        message: "A published target must carry its provider reference.",
      });
    }
  });

/** `publish.reconcile@1`: ask the provider what actually happened. */
export const PublishReconcilePayloadSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  publishTargetId: UlidSchema,
  /** Bounded: polling stops and raises an operator state rather than forever. */
  checkNo: z.int().positive().max(100),
});

export const PublishReconcileResultSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  publishTargetId: UlidSchema,
  status: PublishTargetStatusSchema,
  externalPostId: z.union([z.string().trim().min(1).max(200), z.null()]),
  externalUrl: z.union([HttpsUrlSchema, z.null()]),
  /** Null when the provider's answer is terminal and no further check is due. */
  nextCheckInMs: z.union([z.int().positive().max(86_400_000), z.null()]),
});

/**
 * A signed status callback from the licensed publishing deployment.
 *
 * `deliveryId` plus `sentAt` is the replay guard: a delivery already recorded is
 * acknowledged and dropped, and one outside the freshness window is refused even
 * if its signature verifies.
 */
export const PublishCallbackEventSchema = z.strictObject({
  schemaVersion: z.literal(PUBLISHING_SCHEMA_VERSION),
  deliveryId: z.string().trim().min(1).max(200),
  sentAt: z.iso.datetime(),
  event: z.enum(["post.published", "post.failed", "post.scheduled", "post.cancelled"]),
  /** OUR target id, round-tripped through the service as its reference. */
  publishTargetId: UlidSchema,
  externalPostId: z.union([z.string().trim().min(1).max(200), z.null()]),
  externalUrl: z.union([HttpsUrlSchema, z.null()]),
  error: PublishErrorSchema.nullable(),
});

/** `publish.dispatch:{targetId}:{attemptNo}` — one job per attempt, never reused. */
export function publishDispatchJobKey(targetId: string, attemptNo: number): string {
  return `publish.dispatch:${targetId}:${String(attemptNo)}`;
}

/** `publish.reconcile:{targetId}` — one live reconcile per target at a time. */
export function publishReconcileJobKey(targetId: string): string {
  return `publish.reconcile:${targetId}`;
}

export type ChannelConnectionView = z.infer<typeof ChannelConnectionViewSchema>;
export type ConnectionCapabilities = z.infer<typeof ConnectionCapabilitiesSchema>;
export type PostCopy = z.infer<typeof PostCopySchema>;
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;
export type PublishBatchView = z.infer<typeof PublishBatchViewSchema>;
export type PublishCallbackEvent = z.infer<typeof PublishCallbackEventSchema>;
export type PublishDispatchPayload = z.infer<typeof PublishDispatchPayloadSchema>;
export type PublishDispatchResult = z.infer<typeof PublishDispatchResultSchema>;
export type PublishError = z.infer<typeof PublishErrorSchema>;
export type PublishReconcilePayload = z.infer<typeof PublishReconcilePayloadSchema>;
export type PublishReconcileResult = z.infer<typeof PublishReconcileResultSchema>;
export type PublishTargetView = z.infer<typeof PublishTargetViewSchema>;
