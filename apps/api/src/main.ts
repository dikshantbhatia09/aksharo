import "reflect-metadata";

import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { BRAND } from "@montaj/config";
import type { Env } from "@montaj/config";

import { AppModule } from "./app.module.js";
import { ENV } from "./config/config.module.js";
import { setupOpenApi } from "./openapi.js";
import { APP_VERSION } from "./version.js";

import type { INestApplication } from "@nestjs/common";

export async function bootstrap(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(ENV);

  app.enableShutdownHooks();
  app.enableCors({ origin: [env.WEB_ORIGIN], credentials: true });
  setupOpenApi(app);

  const port = Number(process.env["API_PORT"] ?? new URL(env.API_ORIGIN).port) || 3001;
  await app.listen(port, "0.0.0.0");

  const logger = new Logger("bootstrap");
  logger.log(`${BRAND.name} API ${APP_VERSION} listening on http://localhost:${port}`);
  logger.log(`OpenAPI UI at http://localhost:${port}/docs`);
  return app;
}

bootstrap().catch((error: unknown) => {
  // Startup failures (invalid env, port already bound) must be loud and non-zero.
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
