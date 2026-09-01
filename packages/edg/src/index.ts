/**
 * `@montaj/edg` — the EDG v2 document: Zod schemas, inferred types, the `EdgOp`
 * union, id helpers, fractional ordering and the projection validator.
 *
 * The shapes are frozen in `docs/CONTRACTS.md` §2 and described in
 * `03-architecture/05-system-architecture.md` §4. A02b adds the rebase transform
 * table, compare-and-swap persistence, snapshots and `schemaVersion` migrations.
 */
export * from "./schemas/index.js";
export * from "./ids.js";
export * from "./seq.js";
export * from "./transcript-index.js";
export * from "./validate.js";
