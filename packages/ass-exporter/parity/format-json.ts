/**
 * Formats a JSON document exactly the way `pnpm format`/`prettier --check`
 * expects — through prettier's own Node API, resolving the repo's config
 * (`prettier.config.mjs` -> `@montaj/config/prettier`) for the target file's
 * path, rather than hand-rolling `JSON.stringify(x, null, 2)`.
 *
 * Both `parity/run.ts` (writes `packages/caption-styles/parity/results.json`)
 * and `parity/apply-flags.ts` (writes `packages/caption-styles/styles/*.json`)
 * go through this, so a CI parity run never leaves the tree "dirty" under
 * `pnpm format:check` purely because a plain `JSON.stringify` disagrees with
 * prettier about wrapping a short array onto one line, trailing whitespace,
 * or the final newline.
 *
 * **Why the input is `JSON.stringify(value, null, 2)`, not the single-line
 * form.** Prettier's JSON printer *preserves* whether an object literal was
 * already broken across lines in the source — an object with a newline right
 * after `{` stays multi-line even if it would fit `printWidth`, exactly like
 * every hand-authored `StyleDoc` in `packages/caption-styles/styles/*.json`.
 * Arrays get no such preservation; they always wrap to fit `printWidth`
 * regardless of the source. Feeding prettier the single-line
 * `JSON.stringify(value)` form loses every object's multi-line-ness — every
 * nested object in the file collapses onto one line, which *is* valid
 * prettier output (idempotent, passes `--check`) but is a wholesale
 * reformatting of files nothing about actually changed, drowning the real
 * diff (a flag flip, a new `parityScore`) in noise on every gate run. Starting
 * from the already-two-space-indented form keeps every object exactly as
 * expanded as it already was and fixes only what needed fixing: arrays.
 */

import { format, resolveConfig } from "prettier";

/**
 * `value` -> the prettier-formatted JSON text prettier itself would produce
 * for a file at `filePath` (used only to resolve the right config + parser;
 * the file need not exist yet). Always ends in exactly one trailing newline.
 */
export async function formatJson(value: unknown, filePath: string): Promise<string> {
  const config = (await resolveConfig(filePath)) ?? {};
  const formatted = await format(JSON.stringify(value, null, 2), {
    ...config,
    filepath: filePath,
    parser: "json",
  });
  return formatted.endsWith("\n") ? formatted : `${formatted}\n`;
}
