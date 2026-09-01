import { SetMetadata } from "@nestjs/common";

/** Metadata key `JwtAuthGuard` reads to let a route through unauthenticated. */
export const IS_PUBLIC_KEY = "montaj:public";

/**
 * Mark a route (or a whole controller) as reachable without a bearer token.
 *
 * Only for endpoints that are public *by design* — sign-up, login, the OAuth
 * callback, the device-code endpoints a headless client polls. Everything else
 * stays behind `JwtAuthGuard`.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
