/**
 * `@montaj/render-core` — Backend-independent caption layout (HarfBuzz-wasm, bundled subset fonts) producing DrawCommand[].
 *
 * A01 ships the package skeleton only; the real implementation lands in A16.
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
  name: "@montaj/render-core",
  implementedBy: "A16",
  implemented: false,
};
