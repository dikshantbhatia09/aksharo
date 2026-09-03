/**
 * Typed loader over B18's filler lexicons (`packages/prompts/lexicons/fillers/*.json`).
 *
 * B11's original `fillers.ts` shipped flat in-code arrays; B18 later landed a
 * richer per-language JSON lexicon (`{token, scripts, contextRule, weight}`)
 * for the autocut pass, read directly by the Python worker
 * (`apps/worker-ai/worker_ai/passes/autocut.py::load_lexicon`). Per the
 * 2026-09-02 ruling this package now reads the same JSON as the single
 * source, instead of carrying a second, hand-maintained word list that can
 * drift from it. Anything in this package that wants "the filler words for a
 * language" (e.g. a template avoiding fillers in a generated title) calls
 * {@link loadFillers} for the flat token list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** How a filler is judged in context, mirrored from the JSON (`autocut.py`). */
export type FillerContextRule = "always" | "isolated_only";

export interface FillerEntry {
  readonly token: string;
  readonly scripts: {
    readonly native?: string;
    readonly roman?: string;
  };
  readonly contextRule: FillerContextRule;
  readonly weight: number;
}

export interface FillerLexiconFile {
  readonly language: string;
  readonly version: number;
  readonly description: string;
  readonly entries: readonly FillerEntry[];
}

/** `packages/prompts/lexicons/fillers` — a sibling of both `src` and `dist`. */
function lexiconsRoot(): string {
  return join(__dirname, "..", "..", "lexicons", "fillers");
}

/** Every language file the shipped lexicon set covers (filename stems, not BCP-47 tags). */
export function lexiconLanguages(): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  return readdirSync(lexiconsRoot())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

const fileCache = new Map<string, FillerLexiconFile>();

/** Load and cache one language's raw lexicon file; `undefined` if there is no file for it. */
export function loadLexiconFile(language: string): FillerLexiconFile | undefined {
  const cached = fileCache.get(language);
  if (cached !== undefined) return cached;

  const path = join(lexiconsRoot(), `${language}.json`);
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as FillerLexiconFile;
  fileCache.set(language, parsed);
  return parsed;
}

const tokensCache = new Map<string, readonly string[]>();

/**
 * The flat list of filler tokens for a language (falls back to `en` when the
 * language has no lexicon file, same fallback as the worker's `load_lexicon`).
 */
export function loadFillers(language: string): readonly string[] {
  const cached = tokensCache.get(language);
  if (cached !== undefined) return cached;

  const file = loadLexiconFile(language) ?? loadLexiconFile("en");
  const tokens = (file?.entries ?? []).map((entry) => entry.token);
  tokensCache.set(language, tokens);
  return tokens;
}
