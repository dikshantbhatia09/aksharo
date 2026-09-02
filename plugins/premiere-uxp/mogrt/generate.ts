import { MOGRT_PARAMS } from "./params.js";
import {
  MOGRT_DEFINITION_SCHEMA_VERSION,
  MogrtDefinitionSchema,
  type MogrtDefinition,
} from "./schema.js";

export const MOGRT_GENERATOR_ID = "montaj-mogrt-authoring@1";
export const MOGRT_NAME = "Aksharo Caption";

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
