/**
 * `@montaj/edg` — EDG v2 types, Zod schemas, the EdgOp union, rebase transforms and migrations.
 *
 * A01 ships the package skeleton only; the real implementation lands in A02 (types + schemas), A02b (ops engine).
 * See README.md for what belongs here and docs/PLAN.md for scheduling.
 */

/** Build-time identity of this package, used by diagnostics bundles and the admin console. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  /** Work package(s) that implement it. */
  readonly implementedBy: string;
  /** `false` until the owning work package lands. */
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/edg",
  implementedBy: "A02 (types + schemas), A02b (ops engine)",
  implemented: false,
};
