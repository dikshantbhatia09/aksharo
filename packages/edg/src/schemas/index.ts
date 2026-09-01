/**
 * Every EDG v2 Zod schema and its inferred type, re-exported as
 * `@montaj/edg/schemas`. Nothing outside this package may redefine these shapes
 * (CONTRACTS §2).
 */
export * from "./primitives.js";
export * from "./transcript.js";
export * from "./segment.js";
export * from "./pass.js";
export * from "./document.js";
export * from "./ops.js";
export * from "./json-schema.js";
