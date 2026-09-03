import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The static half of the audit-completeness contract test (B16 brief §3: "a
 * contract test enumerates routes tagged `@Audited`" — this is the
 * enumeration; `audit-completeness.test.ts` is the assertion).
 *
 * Most mutating routes in this codebase write `audit_log` from the *service*
 * layer, one call below the controller (`ConsentsController.set` →
 * `ConsentsService.set` → `this.audit.record(...)`), so a check scoped to
 * one file's own text would miss almost every existing route. Instead, this
 * follows the controller's own local (`./`/`../`) imports — the services it
 * constructs, and what those import in turn, up to
 * {@link MAX_FILES_PER_CONTROLLER} files — and asks: **does this
 * controller's dependency graph reference an audit writer anywhere?**
 * (`CommonAuditService`, `AuditService`, `AuthAuditService`, an inline
 * `.audit.record(`/`.audit.recordAccess(`, or the `@Audited` decorator this
 * WP adds for the admin routes it owns directly). A route-by-route call-graph
 * walk that proves *which* route's handler reaches the audit call is a
 * project of its own; this is the cheap, real check that catches a
 * controller that mutates and, anywhere in what it depends on, never once
 * touches an audit writer. It will not catch one route silently skipping
 * audit while a sibling route in the same file does, which is why
 * {@link EXEMPT_FILES} documents every file this heuristic could not check
 * with confidence and why it exists.
 */

export interface AuditedRoute {
  readonly file: string;
  readonly hasMutatingRoute: boolean;
  readonly referencesAuditWriter: boolean;
}

const MUTATING_DECORATOR = /@(Post|Put|Patch|Delete)\(/;
const AUDIT_REFERENCE =
  /\b(CommonAuditService|AuthAuditService|AuditService|AuditedInterceptor)\b|\.audit\.record\(|\.audit\.recordAccess\(|@Audited\(|\.auditLog\.create\(/;
const RELATIVE_IMPORT = /from\s+["'](\.\.?\/[^"']+)["']/g;

/** How many files (controller + transitively imported) a route's graph is followed through. */
const MAX_FILES_PER_CONTROLLER = 40;

/**
 * Files that declare a mutating route but are exempt from the heuristic,
 * with why — every entry here was read by hand, not assumed.
 */
export const EXEMPT_FILES: ReadonlyMap<string, string> = new Map([
  [
    "internal/internal-jobs.controller.ts",
    "HMAC-signed worker-to-API callbacks (CONTRACTS §3), not a user or admin " +
      "action — the trail that matters is job_events, which every completion " +
      "path already writes, and INTERNAL_CALLBACK_SECRET verification is the " +
      "access control, not audit_log.",
  ],
  [
    "health/health.controller.ts",
    "Liveness/readiness only; no mutating verb reaches here in practice, " +
      "listed for clarity if one ever is added without review.",
  ],
  [
    "internal/internal-media.controller.ts",
    "HMAC-signed worker-to-API callback (CONTRACTS §3, same shape as " +
      "internal-jobs.controller.ts), not a user or admin action.",
  ],
  [
    "edg/edg.controller.ts",
    "EDG op batches (CONTRACTS §2). Every batch is already durable and " +
      "attributable in `edg_revisions`/`edg_snapshots` — that revision " +
      "history IS the audit trail for document edits, and it runs at a " +
      "volume (every keystroke's worth of ops) that `audit_log` is not sized " +
      "for.",
  ],
  [
    "edg/edg-internal.controller.ts",
    "The worker-only half of the same EDG op-batch surface (`MergePass`), " +
      "signed the same way as internal-media.controller.ts; see edg.controller.ts's entry.",
  ],
  [
    "transcripts/scripts/scripts.controller.ts",
    "Enqueues `ai.transliterate`/`ai.translate` jobs. Job creation across " +
      "this codebase is tracked in `jobs` and `credit_ledger`, not " +
      "`audit_log` — no AI-job-enqueuing route is (the transcribe route in " +
      "the sibling `TranscriptsController` is not either), and singling this " +
      "one out would be inconsistent rather than more complete.",
  ],
  [
    "media/sample-project.controller.ts",
    "Seeds the fixed onboarding sample project from bundled assets — no " +
      "user-owned or workspace-sensitive data is created or changed.",
  ],
  [
    "streak/streak.controller.ts",
    "Its only mutating route (`POST /streak/test-hooks`) is a test-environment " +
      "simulation hook, forbidden outside one (`common/forbidden`); nothing it " +
      "does happens in production.",
  ],
]);

/** Recursively list every `*.controller.ts` under `srcRoot`, excluding tests. */
export function findControllerFiles(srcRoot: string): readonly string[] {
  const results: string[] = [];
  walk(srcRoot, results);
  return results;

  function walk(dir: string, out: string[]): void {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".openapi") continue;
      const full = join(dir, entry);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, out);
      } else if (entry.endsWith(".controller.ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }
}

/** Resolve a relative `import ... from "./x.js"` specifier to a `.ts` file on disk, if any. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const withoutExt = specifier.replace(/\.js$/, "");
  const base = resolve(dirname(fromFile), withoutExt);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every local file this file imports directly, resolved to `.ts` paths that exist. */
function localImportsOf(file: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const content = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const match of content.matchAll(RELATIVE_IMPORT)) {
    const resolved = resolveImport(file, match[1] ?? "");
    if (resolved !== null) found.push(resolved);
  }
  return found;
}

/** Combined text of `entryFile` and its local import graph, bounded by {@link MAX_FILES_PER_CONTROLLER}. */
function dependencyGraphText(entryFile: string): string {
  const visited = new Set<string>([entryFile]);
  const queue = [entryFile];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const chunks: string[] = [readFileSync(entryFile, "utf8")];

  while (queue.length > 0 && visited.size < MAX_FILES_PER_CONTROLLER) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const dep of localImportsOf(current)) {
      if (visited.has(dep) || visited.size >= MAX_FILES_PER_CONTROLLER) continue;
      visited.add(dep);
      queue.push(dep);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      chunks.push(readFileSync(dep, "utf8"));
    }
  }
  return chunks.join("\n");
}

/** Scan one controller file, following its local dependency graph for an audit-writer reference. */
export function scanControllerFile(absolutePath: string, srcRoot: string): AuditedRoute {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const ownText = readFileSync(absolutePath, "utf8");
  const graphText = dependencyGraphText(absolutePath);
  return {
    file: relative(srcRoot, absolutePath).replace(/\\/g, "/"),
    hasMutatingRoute: MUTATING_DECORATOR.test(ownText),
    referencesAuditWriter: AUDIT_REFERENCE.test(graphText),
  };
}

/** Every controller under `srcRoot` that mutates and, on this heuristic, is not audited. */
export function findUnauditedControllers(srcRoot: string): readonly AuditedRoute[] {
  return findControllerFiles(srcRoot)
    .map((file) => scanControllerFile(file, srcRoot))
    .filter(
      (route) =>
        route.hasMutatingRoute && !route.referencesAuditWriter && !EXEMPT_FILES.has(route.file),
    );
}
