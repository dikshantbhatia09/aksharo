import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import { ConsentsController } from "./consents.controller.js";
import { ALLOW_BRIDGE_TOKEN_KEY } from "../common/guards/public.decorator.js";

/**
 * `GET /consents` opted into `@AllowBridgeToken()` (M04, C12 follow-up) so the
 * local bridge process can read its own `telemetry` consent on startup and on
 * refresh. This is a metadata-level contract test — `JwtAuthGuard`'s own
 * behaviour for that metadata is covered by `guards.test.ts`'s
 * "lets a bridge token through a route that opts in" case; this test only
 * proves `ConsentsController.list` actually carries the metadata, so a future
 * refactor that drops the decorator fails here rather than only being
 * noticed when the bridge starts getting 403s in production.
 */
describe("ConsentsController route metadata", () => {
  it("marks GET /consents with @AllowBridgeToken()", () => {
    const reflector = new Reflector();
    const allowed = reflector.get<boolean>(
      ALLOW_BRIDGE_TOKEN_KEY,
      ConsentsController.prototype.list,
    );
    expect(allowed).toBe(true);
  });

  it("leaves POST /consents (a write) without @AllowBridgeToken()", () => {
    const reflector = new Reflector();
    const allowed = reflector.get<boolean>(
      ALLOW_BRIDGE_TOKEN_KEY,
      ConsentsController.prototype.set,
    );
    expect(allowed).toBeUndefined();
  });
});
