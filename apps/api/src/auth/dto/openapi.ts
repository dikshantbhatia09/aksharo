import { z } from "zod";

import type { ApiBodyOptions, ApiResponseOptions, SchemaObject } from "@nestjs/swagger";
import type { ZodType } from "zod";

/**
 * Bridge from Zod to the OpenAPI document.
 *
 * `zodDto()` classes have no decorated properties -- validation is the schema's
 * job -- so `@nestjs/swagger` would document them as empty objects and
 * `@montaj/api-client` would be generated with `unknown` request bodies. Passing
 * the converted schema explicitly keeps one definition of every payload.
 *
 * `target: "openapi-3.0"` matters: the default output is JSON Schema 2020-12,
 * whose nullable unions (`type: ["string", "null"]`) OpenAPI 3.0 tooling rejects.
 */
function convert(schema: ZodType): SchemaObject {
  return z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" }) as SchemaObject;
}

/** `@ApiBody(zodBody(signUpSchema))` */
export function zodBody(schema: ZodType): ApiBodyOptions {
  return { schema: convert(schema) };
}

/** `@ApiOkResponse(zodResponse(tokenResponseSchema, "Access and refresh tokens."))` */
export function zodResponse(schema: ZodType, description: string): ApiResponseOptions {
  return { description, schema: convert(schema) };
}

/** A response that is a list of `schema`. */
export function zodArrayResponse(schema: ZodType, description: string): ApiResponseOptions {
  return { description, schema: { type: "array", items: convert(schema) } };
}
