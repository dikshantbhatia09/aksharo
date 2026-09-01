/**
 * `@montaj/caption-styles` — StyleDoc v2 schema, the 30+ system styles and CI-written parity flags.
 *
 * A01 ships the package skeleton only; the real implementation lands in A02 (schema), A16 (styles), A18a (parity flags).
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
  name: "@montaj/caption-styles",
  implementedBy: "A02 (schema), A16 (styles), A18a (parity flags)",
  implemented: false,
};
