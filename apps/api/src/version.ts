/**
 * Version reported by `GET /health` and stamped on the OpenAPI document.
 *
 * Kept in step with `package.json` by `src/version.test.ts`, which fails if the
 * two ever drift — reading `package.json` at runtime would break once the API is
 * bundled into a container image with a different layout.
 */
export const APP_VERSION = "0.1.0";
