/**
 * `@montaj/api-client` — OpenAPI-generated API client and TanStack Query hooks.
 *
 * `pnpm gen:client` regenerates `openapi.json` (the whole document) and
 * `src/generated/operations.ts` (a typed index of every operation) from the API's
 * own Swagger output. A13 adds the fetch layer and the TanStack Query hooks on
 * top of them, which is why `PACKAGE_INFO.implemented` is still `false`.
 *
 * See README.md for what belongs here and docs/PLAN.md for scheduling.
 */

export { API_OPERATIONS, API_VERSION, findOperation } from "./generated/operations.js";
export type { ApiOperation, ApiOperationId } from "./generated/operations.js";

/** Build-time identity of this package, used by diagnostics bundles and the admin console. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  /** Work package(s) that implement it. */
  readonly implementedBy: string;
  /** `false` until the owning work package lands. */
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/api-client",
  implementedBy: "A03 (spec), A13 (hooks)",
  implemented: false,
};
