import { z } from "zod";

import { zodDto } from "../../common/index.js";

/**
 * Request and response schemas for every auth endpoint.
 *
 * The schemas are the single source of truth: `zodDto` turns each one into the
 * class the global validation pipe uses, and `openApiSchema()` turns the same one
 * into the OpenAPI body that `@montaj/api-client` is generated from. There is no
 * second, hand-written description of a request that can drift.
 *
 * Password and date-of-birth *policy* is not enforced here. A schema failure is
 * `common/validation_failed`; a password that is too short or a minor's date of
 * birth need their own codes (`auth/weak_password`, `auth/age_restricted`), so the
 * services raise those.
 */

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export const emailSchema = z.string().trim().min(3).max(254).email();
export const ulidSchema = z.string().regex(ULID, "must be a ULID");
export const jurisdictionSchema = z.enum(["IN", "EU", "OTHER"]);
export const clientKindSchema = z.enum([
  "web",
  "desktop",
  "bridge",
  "premiere",
  "ae",
  "resolve",
  "api",
]);
export const hostAppSchema = z.enum(["web", "desktop", "premiere", "ae", "resolve"]);
export const oauthClientSchema = z.enum(["web", "desktop", "bridge"]);

/** Per-purpose consent from the sign-up form. Every purpose defaults to false. */
export const consentsSchema = z.object({
  analytics: z.boolean().optional(),
  memory: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

/** `YYYY-MM-DD`; `users.date_of_birth` is a `date` column, with no time part. */
export const dateOfBirthSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const signUpSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(120).optional(),
  locale: z.string().trim().max(16).optional(),
  dateOfBirth: dateOfBirthSchema,
  jurisdiction: jurisdictionSchema,
  consents: consentsSchema.optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  kind: clientKindSchema.optional(),
});

export const verifyEmailSchema = z.object({ token: z.string().min(16).max(256) });

export const magicLinkRequestSchema = z.object({ email: emailSchema });

export const magicLinkConsumeSchema = z.object({
  token: z.string().min(16).max(256),
  kind: clientKindSchema.optional(),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(16).max(256) });

export const logoutSchema = z.object({ refreshToken: z.string().min(16).max(256) });

export const tokenExchangeSchema = z.object({ workspaceId: ulidSchema });

export const parentalWaitlistSchema = z.object({ email: emailSchema });

export const oauthCompleteSchema = z.object({
  code: z.string().min(16).max(256),
  dateOfBirth: dateOfBirthSchema.optional(),
  jurisdiction: jurisdictionSchema.optional(),
  consents: consentsSchema.optional(),
});

/** Free-form device facts for the approval screen; bounded so it cannot be abused. */
export const deviceInfoSchema = z
  .record(z.string().max(32), z.string().max(200))
  .refine((value) => Object.keys(value).length <= 16, "at most 16 entries");

export const deviceCodeRequestSchema = z.object({
  clientKind: z.enum(["desktop", "bridge", "premiere", "ae", "resolve"]),
  hostApp: hostAppSchema.optional(),
  deviceInfo: deviceInfoSchema.optional(),
});

export const deviceTokenSchema = z.object({ deviceCode: z.string().min(16).max(256) });

export const deviceApproveSchema = z.object({
  userCode: z.string().min(8).max(16),
  workspaceId: ulidSchema.optional(),
  decision: z.enum(["approve", "deny"]).optional(),
});

// --- Response shapes (documentation only; the services build the objects) ----

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  tokenType: z.literal("Bearer"),
  sessionId: ulidSchema,
  workspaceId: ulidSchema,
  role: z.enum(["owner", "admin", "editor", "viewer"]),
  kind: clientKindSchema,
});

export const signUpResponseSchema = z.object({
  status: z.literal("verification_sent"),
  email: z.string(),
});

export const sessionSummarySchema = z.object({
  id: ulidSchema,
  kind: clientKindSchema,
  workspaceId: ulidSchema,
  ip: z.string().nullable(),
  ua: z.string().nullable(),
  createdAt: z.string(),
  rotatedAt: z.string().nullable(),
  expiresAt: z.string(),
  current: z.boolean(),
});

export const deviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  verificationUrlComplete: z.string(),
  interval: z.number().int(),
  expiresIn: z.number().int(),
});

export const pendingApprovalSchema = z.object({
  userCode: z.string(),
  clientKind: clientKindSchema,
  hostApp: hostAppSchema.nullable(),
  deviceInfo: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  location: z
    .object({
      country: z.string().optional(),
      region: z.string().optional(),
      city: z.string().optional(),
    })
    .nullable(),
  expiresAt: z.string(),
});

// --- DTO classes (the validation pipe keys off the parameter type) ----------

export class SignUpDto extends zodDto(signUpSchema) {}
export class LoginDto extends zodDto(loginSchema) {}
export class VerifyEmailDto extends zodDto(verifyEmailSchema) {}
export class MagicLinkRequestDto extends zodDto(magicLinkRequestSchema) {}
export class MagicLinkConsumeDto extends zodDto(magicLinkConsumeSchema) {}
export class RefreshDto extends zodDto(refreshSchema) {}
export class LogoutDto extends zodDto(logoutSchema) {}
export class TokenExchangeDto extends zodDto(tokenExchangeSchema) {}
export class ParentalWaitlistDto extends zodDto(parentalWaitlistSchema) {}
export class OAuthCompleteDto extends zodDto(oauthCompleteSchema) {}
export class DeviceCodeRequestDto extends zodDto(deviceCodeRequestSchema) {}
export class DeviceTokenDto extends zodDto(deviceTokenSchema) {}
export class DeviceApproveDto extends zodDto(deviceApproveSchema) {}
