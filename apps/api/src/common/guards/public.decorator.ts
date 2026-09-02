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

/**
 * Metadata key `JwtAuthGuard` reads to let a `kind: "bridge"` access token
 * through on a route that is otherwise for user-facing clients only.
 *
 * B08b (CONTRACTS §5 amended 2026-09-03): a bridge token authenticates one
 * local bridge process, not a user sitting at a browser or plugin, so it must
 * not be usable against ordinary `/projects`, `/billing`, etc. routes just
 * because it carries a real `sub`/`ws`. The allowlist is empty today — no
 * route needs a bridge token through `JwtAuthGuard` yet, since `/bridge/relay`
 * verifies the token itself and `/devices/*` mints it from an ordinary user
 * token — so `@AllowBridgeToken()` exists for a future route to opt in
 * explicitly rather than for anything to use today.
 */
export const ALLOW_BRIDGE_TOKEN_KEY = "montaj:allow-bridge-token";

export const AllowBridgeToken = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_BRIDGE_TOKEN_KEY, true);
