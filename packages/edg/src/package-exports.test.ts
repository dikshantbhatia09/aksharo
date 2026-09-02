import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the built artefacts are real: CommonJS for the monorepo, ES modules for
 * bundlers and the browser, types for both, and the `.`, `./schemas` and `./seq`
 * subpaths resolving from a TypeScript file compiled against the package.
 */

const PACKAGE_ROOT = join(__dirname, "..");
const DIST = join(PACKAGE_ROOT, "dist");
const TSC = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");
const SCRATCH = join(PACKAGE_ROOT, ".tmp", "exports-check");

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe" });
}

beforeAll(() => {
  // `pnpm --filter @montaj/edg test` must stand on its own, so build on demand.
  if (!existsSync(join(DIST, "index.js")) || !existsSync(join(DIST, "esm", "index.js"))) {
    run(process.execPath, [TSC, "-p", "tsconfig.build.json"]);
    run(process.execPath, [TSC, "-p", "tsconfig.esm.json"]);
    run(process.execPath, [join(PACKAGE_ROOT, "scripts", "finalise-esm-build.mjs")]);
  }
}, 180_000);

describe("build output", () => {
  it("emits CommonJS that the workers and the API can require", () => {
    const script = [
      "const pkg = require('./dist/index.js');",
      "const schemas = require('./dist/schemas/index.js');",
      "const seq = require('./dist/seq.js');",
      "if (typeof pkg.seqBetween !== 'function') throw new Error('missing seqBetween');",
      "if (!schemas.EdgProjectionSchema) throw new Error('missing EdgProjectionSchema');",
      "process.stdout.write(seq.seqBetween());",
    ].join("\n");
    expect(run(process.execPath, ["-e", script])).toBe("V");
  });

  it("emits ES modules that Node loads as ESM", () => {
    const script = [
      "const url = require('node:url').pathToFileURL('./dist/esm/index.js').href;",
      "import(url).then((m) => {",
      "  if (typeof m.seqBetween !== 'function') throw new Error('missing seqBetween');",
      "  process.stdout.write(String(m.EDG_OP_TYPES.length));",
      "});",
    ].join("\n");
    expect(run(process.execPath, ["-e", script])).toBe("17");
    expect(JSON.parse(readFileSync(join(DIST, "esm", "package.json"), "utf8"))).toEqual({
      type: "module",
    });
    expect(readFileSync(join(DIST, "esm", "seq.js"), "utf8")).toMatch(/^export /m);
  });

  it("emits declarations for both conditions", () => {
    for (const file of ["index.d.ts", "schemas/index.d.ts", "seq.d.ts"]) {
      expect(existsSync(join(DIST, file)), `dist/${file}`).toBe(true);
      expect(existsSync(join(DIST, "esm", file)), `dist/esm/${file}`).toBe(true);
    }
  });

  it("resolves every subpath export from a TypeScript file", () => {
    mkdirSync(SCRATCH, { recursive: true });
    const scratch = join(SCRATCH, "consumer.ts");
    writeFileSync(
      scratch,
      [
        'import { type EdgOp, EdgOpSchema, newId } from "@montaj/edg";',
        'import { EdgProjectionSchema, type Segment } from "@montaj/edg/schemas";',
        'import { seqBetween } from "@montaj/edg/seq";',
        "",
        "const op: EdgOp = EdgOpSchema.parse({",
        '  opId: newId(), type: "HideSegment", segmentId: newId(), hidden: true,',
        "});",
        "const segment: Segment = {",
        "  id: newId(),",
        "  seq: seqBetween(),",
        '  startWordId: "0:0",',
        '  endWordId: "0:3",',
        "  startMs: 0,",
        "  endMs: 900,",
        "};",
        "const projection = EdgProjectionSchema.safeParse({ segments: [segment] });",
        "export const summary = `${op.type} ${segment.seq} ${String(projection.success)}`;",
      ].join("\n"),
      "utf8",
    );
    try {
      run(process.execPath, [
        TSC,
        "--noEmit",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--skipLibCheck",
        scratch,
      ]);
    } finally {
      rmSync(SCRATCH, { recursive: true, force: true });
    }
  }, 120_000);
});
