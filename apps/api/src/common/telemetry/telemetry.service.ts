import { Injectable, type OnApplicationShutdown } from "@nestjs/common";

import { shutdownTelemetry } from "./otel.js";

/**
 * Flush and stop the OpenTelemetry SDK when the application shuts down.
 *
 * Tracing is started in `main.ts` before Nest exists, so it cannot own its own
 * teardown; this provider joins it to `app.enableShutdownHooks()`, which is what
 * makes the last spans of a rolling deploy actually reach the collector.
 */
@Injectable()
export class TelemetryService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}
