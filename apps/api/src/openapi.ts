import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

import { BRAND } from "@montaj/config";

import { APP_VERSION } from "./version.js";

import type { INestApplication } from "@nestjs/common";

/**
 * Mount the OpenAPI document: Swagger UI at `/docs`, raw JSON at `/docs-json`.
 *
 * `packages/api-client` is generated from `/docs-json`, so the document is a
 * contract: it changes before its consumers do (10-build-plan section 2).
 */
export function setupOpenApi(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${BRAND.name} API`)
      .setDescription(
        "Errors use the envelope `{ error: { code, message, details?, requestId } }` " +
          "with `namespace/slug` codes (CONTRACTS section 8).",
      )
      .setVersion(APP_VERSION)
      .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" }, "access-token")
      .build(),
  );

  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs-json",
    customSiteTitle: `${BRAND.name} API`,
  });
}
