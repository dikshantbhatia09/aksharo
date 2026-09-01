import { Global, Logger, Module } from "@nestjs/common";

import { AuthAuditService } from "./auth-audit.service.js";
import { AuthMailerService } from "./auth-mailer.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { BreachedPasswordService } from "./breached-password.service.js";
import { DeviceCodeService } from "./device-code.service.js";
import { DeviceController } from "./device.controller.js";
import { GOOGLE_OAUTH_PROVIDER, HttpGoogleOAuthProvider } from "./google-oauth.provider.js";
import { GoogleOAuthService } from "./google-oauth.service.js";
import { OAuthController } from "./oauth.controller.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";
import { TokenService } from "./token.service.js";
import {
  ACCESS_TOKEN_VERIFIER,
  JwtAuthGuard,
  RolesGuard,
  ApiKeyGuard,
  RateLimitGuard,
} from "../common/guards/index.js";
import { RateLimitService } from "../common/guards/rate-limit.service.js";
import { RedisService } from "../common/index.js";
import { UsersModule } from "../users/users.module.js";

import type { OnModuleInit } from "@nestjs/common";

/**
 * Authentication: email and password, Google (PKCE), magic links, refresh-token
 * families, the device grant, workspace token exchange and sessions.
 *
 * `@Global()` for one reason: `JwtAuthGuard` resolves {@link ACCESS_TOKEN_VERIFIER}
 * from the module that instantiates it, and every feature module from A05 onwards
 * wears that guard. Making the binding global means a feature module protects a
 * route with `@UseGuards(JwtAuthGuard)` and imports nothing, which is the only way
 * "every route has a membership guard" (THREAT-MODEL T4) stays true as the number
 * of modules grows.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AuthController, OAuthController, DeviceController],
  providers: [
    AuthService,
    AuthAuditService,
    AuthMailerService,
    BreachedPasswordService,
    DeviceCodeService,
    GoogleOAuthService,
    PasswordService,
    SessionService,
    TokenService,
    RateLimitService,
    JwtAuthGuard,
    RolesGuard,
    ApiKeyGuard,
    RateLimitGuard,
    { provide: ACCESS_TOKEN_VERIFIER, useExisting: TokenService },
    { provide: GOOGLE_OAUTH_PROVIDER, useClass: HttpGoogleOAuthProvider },
  ],
  exports: [
    ACCESS_TOKEN_VERIFIER,
    ApiKeyGuard,
    AuthAuditService,
    JwtAuthGuard,
    RateLimitGuard,
    RateLimitService,
    RolesGuard,
    SessionService,
    TokenService,
  ],
})
export class AuthModule implements OnModuleInit {
  private readonly logger = new Logger(AuthModule.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Open the Redis connection at boot instead of on the first sign-in.
   *
   * `RedisService` is deliberately lazy and refuses to queue commands while it is
   * offline, so without this the very first rate-limit check after a deploy would
   * fail on a connection that had not been dialled yet — and the limiter fails
   * open, which means the first request past a cold start would skip its bucket.
   *
   * Not fatal: Redis being down is a readiness-probe problem, not a reason to
   * refuse to boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.redis.ping();
    } catch (error) {
      this.logger.warn({ err: error }, "redis is not reachable at boot");
    }
  }
}
