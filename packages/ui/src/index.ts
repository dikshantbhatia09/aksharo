/**
 * `@montaj/ui` — Design tokens and shared React components (shadcn/ui based).
 *
 * A01 ships the package skeleton only; the real implementation lands in A13.
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
  name: "@montaj/ui",
  implementedBy: "A13",
  implemented: false,
};
