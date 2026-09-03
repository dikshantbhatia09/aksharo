import { MOGRT_PARAMS } from "./params.js";
import {
  MOGRT_DEFINITION_SCHEMA_VERSION,
  MogrtDefinitionSchema,
  type MogrtDefinition,
} from "./schema.js";
import { TITLE_PARAMS } from "./title-params.js";

export const MOGRT_GENERATOR_ID = "montaj-mogrt-authoring@1";
export const MOGRT_NAME = "Aksharo Caption";
/** D09: the second MOGRT this generator produces, see `title-params.ts`'s doc comment. */
export const TITLE_MOGRT_NAME = "Aksharo Title";

/**
 * Builds `definition.json`'s contents deterministically from the frozen param
 * table (`params.ts`). Pure function: same output every call, which is what
 * lets `generate.test.ts` pin it against a golden fixture.
 */
export function generateMogrtDefinition(options: { placeholder: boolean }): MogrtDefinition {
  const definition: MogrtDefinition = {
    schemaVersion: MOGRT_DEFINITION_SCHEMA_VERSION,
    generator: MOGRT_GENERATOR_ID,
    mogrtName: MOGRT_NAME,
    placeholder: options.placeholder,
    params: MOGRT_PARAMS.map((param) => ({ ...param })),
  };
  // Parse-and-return so a drift between params.ts and schema.ts fails loudly
  // here rather than downstream in a consumer.
  return MogrtDefinitionSchema.parse(definition);
}

/**
 * Builds the title MOGRT's `definition.json` (D09 brief §Scope 1: "add its definition to
 * C06b's generator in this WP"). Same determinism/parse-and-return contract as
 * `generateMogrtDefinition` above, over the 15-param `title-params.ts` table instead.
 */
export function generateTitleMogrtDefinition(options: { placeholder: boolean }): MogrtDefinition {
  const definition: MogrtDefinition = {
    schemaVersion: MOGRT_DEFINITION_SCHEMA_VERSION,
    generator: MOGRT_GENERATOR_ID,
    mogrtName: TITLE_MOGRT_NAME,
    placeholder: options.placeholder,
    params: TITLE_PARAMS.map((param) => ({ ...param })),
  };
  return MogrtDefinitionSchema.parse(definition);
}
