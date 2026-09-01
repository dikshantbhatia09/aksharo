import { Global, Module } from "@nestjs/common";

import { CREDITS_FACADE } from "./credits.facade.js";
import { NoopCreditsFacade } from "./noop-credits.facade.js";

/**
 * Binds {@link CREDITS_FACADE} to the Wave 1 no-op implementation.
 *
 * `@Global()` because every job producer (A07, A09, A11, A20, A21, A22) needs the
 * facade and none of them should have to import a credits module to get it. B02
 * changes exactly one line here — `useClass` — and nothing else in the codebase.
 *
 * `NoopCreditsFacade` is also exported as a class so tests can reach the concrete
 * instance's `holdStatus()`/`reset()` helpers.
 */
@Global()
@Module({
  providers: [NoopCreditsFacade, { provide: CREDITS_FACADE, useExisting: NoopCreditsFacade }],
  exports: [CREDITS_FACADE, NoopCreditsFacade],
})
export class CreditsModule {}
