/**
 * Guards, decorators and the rate limiter every feature module shares.
 *
 * `AuthModule` is `@Global()` and binds {@link ACCESS_TOKEN_VERIFIER}, so a
 * feature module can `@UseGuards(JwtAuthGuard)` without importing anything.
 */

export {
  API_KEY_HEADER,
  API_SCOPES_KEY,
  ApiKeyGuard,
  ApiScopes,
  hashApiKeySecret,
  parseApiKey,
} from "./api-key.guard.js";
export { CurrentUser, CurrentWorkspace } from "./current-user.decorator.js";
export { bearerToken, JwtAuthGuard } from "./jwt-auth.guard.js";
export {
  ACCESS_TOKEN_VERIFIER,
  clientIp,
  clientUserAgent,
  roleAtLeast,
  ROLE_ORDER,
} from "./principal.js";
export type {
  AccessTokenClaims,
  AccessTokenVerifier,
  AuthenticatedRequest,
  AuthPrincipal,
} from "./principal.js";
export { IS_PUBLIC_KEY, Public } from "./public.decorator.js";
export { RATE_LIMIT_KEY, RateLimit, RateLimitGuard } from "./rate-limit.guard.js";
export type { RateLimitRule, RateLimitSubject } from "./rate-limit.guard.js";
export { RATE_LIMIT_PREFIX, RateLimitService, TOKEN_BUCKET_LUA } from "./rate-limit.service.js";
export type { BucketSpec, BucketVerdict } from "./rate-limit.service.js";
export { Roles, ROLES_KEY, RolesGuard } from "./roles.guard.js";
