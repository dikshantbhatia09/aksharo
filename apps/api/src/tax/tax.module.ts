import { Module } from "@nestjs/common";

import { createExchangeRateProvider, EXCHANGE_RATE_PROVIDER } from "./exchange-rate.js";
import { TaxEngineService } from "./tax-engine.service.js";

/**
 * The tax engine (B05 brief §1): place of supply, intra/inter/export/RCM rate
 * selection, Rule 35 inclusive back-computation and the USD exchange rate.
 * Pure computation — no Prisma model of its own; `invoices/` is the only
 * consumer and owns persistence.
 */
@Module({
  providers: [
    TaxEngineService,
    { provide: EXCHANGE_RATE_PROVIDER, useFactory: createExchangeRateProvider },
  ],
  exports: [TaxEngineService, EXCHANGE_RATE_PROVIDER],
})
export class TaxModule {}
