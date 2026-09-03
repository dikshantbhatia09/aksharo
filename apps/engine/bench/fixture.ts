import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loader for the committed Hinglish reference set (brief scope item 1),
 * `apps/engine/fixtures/hinglish-reference.json` — A23's 90s sample plus
 * D08's `hinglish-mini` eval-set references against a cloud-aligner
 * snapshot. See that file's own `description`/`note` fields for provenance.
 */

export interface ReferenceWord {
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface ReferenceItem {
  readonly id: string;
  /** Substring matched against a `/transcribe`|`/align` request's `audio` field by `FakeBackend` (`../src/backends/fake-backend.ts`). */
  readonly audioMatch: string;
  readonly language: string;
  readonly source: string;
  readonly cloudAligner?: string;
  readonly referenceText: string;
  readonly note?: string;
  /** `null` for a text-only reference (WER/CER only, no word-boundary figure). */
  readonly words: readonly ReferenceWord[] | null;
}

interface FixtureFile {
  readonly v: 1;
  readonly description: string;
  readonly items: readonly ReferenceItem[];
}

// CommonJS output (this package's `type: "commonjs"`), so `__dirname` is
// available natively — no `import.meta.url` dance needed.
const DEFAULT_FIXTURE_PATH = join(__dirname, "..", "fixtures", "hinglish-reference.json");

export function loadHinglishReference(
  path: string = DEFAULT_FIXTURE_PATH,
): readonly ReferenceItem[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  if (parsed.v !== 1) {
    throw new Error(`unsupported hinglish-reference.json version: ${String(parsed.v)}`);
  }
  return parsed.items;
}
