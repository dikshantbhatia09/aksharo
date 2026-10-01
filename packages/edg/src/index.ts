/**
 * `@montaj/edg` — the EDG v2 document: Zod schemas, inferred types, the `EdgOp`
 * union, id helpers, fractional ordering and the projection validator.
 *
 * The shapes are frozen in `docs/CONTRACTS.md` §2 and described in
 * `03-architecture/05-system-architecture.md` §4. A02b added the ops engine:
 * `applyOps`, the rebase transform table, the segmenter, snapshots and
 * `schemaVersion` migrations.
 */
export * from "./schemas/index.js";
export * from "./ids.js";
export * from "./seq.js";
export * from "./transcript-index.js";
export * from "./validate.js";
export * from "./ops/index.js";
export * from "./segmenter/index.js";
export * from "./migrations/index.js";
export * from "./passes/keyframes.js";
export * from "./timeline-ops.js";
// How a workspace's brand kit becomes style overrides and overlays (2026-10-02).
export * from "./brand.js";
// Where a B-roll cutaway goes, for Autopilot and the editor alike (2026-10-05).
export * from "./broll.js";
// The voice-over hook as an accepted `sfx` cue (2026-10-01).
export * from "./voiceover.js";
