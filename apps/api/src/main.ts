import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { AppModule } from "./app.module.js";
import { HttpExceptionFilter } from "./common/errors/http-exception.filter.js";
import { startTelemetry } from "./common/telemetry/otel.js";
import { ENV } from "./config/config.module.js";
import { applyInternalBodyLimit } from "./internal/internal-body-limit.js";
import { setupOpenApi } from "./openapi.js";
import { APP_VERSION } from "./version.js";

import type { INestApplication } from "@nestjs/common";

export async function bootstrap(): Promise<INestApplication> {
  // Before NestFactory: the HTTP instrumentation has to patch `http` before Nest
  // requires it. A no-op when no OTLP endpoint is configured. `TelemetryService`
  // (in CommonModule) shuts it down again through the application's own hooks.
  await startTelemetry({ serviceVersion: APP_VERSION });

  // `rawBody` keeps the exact request bytes on `req.rawBody`. The worker → API
  // callbacks are HMAC'd over the body as sent (CONTRACTS §3), and a re-serialised
  // body would not reproduce the signature a Python worker computed.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(PinoLogger));

  // Before the adapter registers its own 100 kB parser (`app.listen()` → `init()`):
  // an `ai.transcribe` completion carries a whole transcript. A11.
  applyInternalBodyLimit(app);

  const env = app.get<Env>(ENV);

  // Registered here rather than as an APP_FILTER provider so it also catches
  // failures raised before the router runs (CONTRACTS §8).
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableShutdownHooks();
  app.enableCors({ origin: [env.WEB_ORIGIN], credentials: true });
  setupOpenApi(app);

  const port = Number(process.env["API_PORT"] ?? new URL(env.API_ORIGIN).port) || 3001;
  await app.listen(port, "0.0.0.0");

  const logger = app.get(PinoLogger);
  logger.log(`${BRAND.name} API ${APP_VERSION} listening on http://localhost:${port}`);
  logger.log(`OpenAPI UI at http://localhost:${port}/docs`);
  return app;
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    // Startup failures (invalid env, port already bound) must be loud and non-zero,
    // and happen before the logger exists.
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
