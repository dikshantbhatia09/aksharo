/**
 * `@montaj/timemap` — Source-time to output-time mapping across accepted cuts and speed changes.
 *
 * A01 ships the package skeleton only; the real implementation lands in A02c.
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
  name: "@montaj/timemap",
  implementedBy: "A02c",
  implemented: false,
};
