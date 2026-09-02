import { Module } from "@nestjs/common";

import { TelemetryForwarderService } from "./telemetry-forwarder.service.js";
import { TelemetryController } from "./telemetry.controller.js";
import { TelemetryService } from "./telemetry.service.js";
import { ConsentsModule } from "../consents/consents.module.js";

/**
 * Consent-gated telemetry events and crash reports (C12 brief §1). Imports
 * `ConsentsModule` for `ConsentsService` — the same per-purpose consent every
 * other DPDP-gated feature (memory, marketing) already reads.
 */
@Module({
  imports: [ConsentsModule],
  controllers: [TelemetryController],
  providers: [TelemetryService, TelemetryForwarderService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
