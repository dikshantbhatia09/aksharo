/**
 * The auth module's public surface.
 *
 * Feature modules from A05 onwards need the guards (re-exported from `common`)
 * and, occasionally, `SessionService` and `TokenService`; everything else here is
 * internal to the module.
 */

export { AuthModule } from "./auth.module.js";
export { AUTH_ERRORS, RATE_LIMITS } from "./auth.constants.js";
export type { AuthErrorCode } from "./auth.constants.js";
export { AUTH_AUDIT_ACTIONS, AuthAuditService } from "./auth-audit.service.js";
export type { AuditEntry, AuthAuditAction } from "./auth-audit.service.js";
export { ageInYears, evaluateAgeGate, MINIMUM_AGE } from "./age-gate.js";
export type { AgeGateVerdict } from "./age-gate.js";
export { SessionService } from "./session.service.js";
export type { IssuedTokens, SessionSummary } from "./session.service.js";
export { TokenService } from "./token.service.js";
