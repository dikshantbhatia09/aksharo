import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Proves the built artefacts are real: CommonJS for the API and the workers, ES
 * modules for the browser exporter, the timeline UI and the NLE panels, and types
 * for both conditions.
 */

const PACKAGE_ROOT = join(__dirname, "..");
const DIST = join(PACKAGE_ROOT, "dist");
const TSC = join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc");
const EDG_ROOT = join(PACKAGE_ROOT, "..", "edg");
const SCRATCH = join(PACKAGE_ROOT, ".tmp", "exports-check");

function run(command: string, args: string[], cwd = PACKAGE_ROOT): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

beforeAll(() => {
  // `pnpm --filter @montaj/timemap test` must stand on its own, so build on
  // demand — including the declarations of `@montaj/edg`, whose `Segment`,
  // `Word` and `PassItem` types this package's own declarations refer to.
  if (!existsSync(join(EDG_ROOT, "dist", "index.d.ts"))) {
    run(process.execPath, [TSC, "-p", "tsconfig.build.json"], EDG_ROOT);
  }
  if (!existsSync(join(DIST, "index.js")) || !existsSync(join(DIST, "esm", "index.js"))) {
    run(process.execPath, [TSC, "-p", "tsconfig.build.json"]);
    run(process.execPath, [TSC, "-p", "tsconfig.esm.json"]);
    run(process.execPath, [join(PACKAGE_ROOT, "scripts", "finalise-esm-build.mjs")]);
  }
}, 180_000);

describe("build output", () => {
  it("emits CommonJS that the API and the workers can require", () => {
    const script = [
      "const pkg = require('./dist/index.js');",
      "const map = pkg.buildTimeMap({ sourceDurationMs: 1000, edits: [pkg.cutEdit(200, 400)] });",
      "if (map.toOutput(300) !== null) throw new Error('cut interior should be null');",
      "process.stdout.write(String(map.outputDurationMs));",
    ].join("\n");
    expect(run(process.execPath, ["-e", script])).toBe("800");
  });

  it("emits ES modules that Node loads as ESM", () => {
    const script = [
      "const url = require('node:url').pathToFileURL('./dist/esm/index.js').href;",
      "import(url).then((m) => {",
      "  const map = m.buildTimeMap({ sourceDurationMs: 1000, edits: [m.cutEdit(200, 400)] });",
      "  process.stdout.write(String(map.toSource(200)));",
      "});",
    ].join("\n");
    expect(run(process.execPath, ["-e", script])).toBe("400");
    expect(JSON.parse(readFileSync(join(DIST, "esm", "package.json"), "utf8"))).toEqual({
      type: "module",
    });
    expect(readFileSync(join(DIST, "esm", "index.js"), "utf8")).toMatch(/^export /m);
  });

  it("emits declarations for both conditions", () => {
    for (const file of ["index.d.ts", "timemap.d.ts", "query.d.ts"]) {
      expect(existsSync(join(DIST, file)), `dist/${file}`).toBe(true);
      expect(existsSync(join(DIST, "esm", file)), `dist/esm/${file}`).toBe(true);
    }
  });

  it("imports nothing Node-only, so the browser exporter can bundle it", () => {
    const forbidden = /require\(["']node:|from ["']node:|require\(["'](fs|path|crypto|os)["']/;
    for (const file of ["index.js", "timemap.js", "spans.js", "edits.js", "search.js"]) {
      expect(readFileSync(join(DIST, file), "utf8"), file).not.toMatch(forbidden);
      expect(readFileSync(join(DIST, "esm", file), "utf8"), `esm/${file}`).not.toMatch(forbidden);
    }
  });

  it("resolves the package export from a TypeScript file", () => {
    mkdirSync(SCRATCH, { recursive: true });
    const scratch = join(SCRATCH, "consumer.ts");
    writeFileSync(
      scratch,
      [
        'import type { PassItem, Segment, Word } from "@montaj/edg";',
        'import { buildTimeMap, fromAcceptedItems, snapToFrame, type TimeMap } from "@montaj/timemap";',
        "",
        "const map: TimeMap = buildTimeMap({",
        "  sourceDurationMs: 10_000,",
        '  edits: [{ kind: "cut", startMs: 2000, endMs: 3000 }],',
        "});",
        "const items: PassItem[] = [];",
        "const fromPass = fromAcceptedItems(items, { sourceDurationMs: 10_000 });",
        "const segment: Segment = {",
        '  id: "01JBZ9F8Q0000000000000000A",',
        '  seq: "V",',
        '  startWordId: "0:0",',
        '  endWordId: "0:3",',
        "  startMs: 1500,",
        "  endMs: 3500,",
        "};",
        'const words: Word[] = [{ wid: "0:0", s: 1500, e: 1900, t: "hello" }];',
        "const mapped = map.mapSegment(segment, words);",
        "const keys = map.mapKeyframes([{ tMs: 0, scale: 1 }]);",
        "export const summary = [",
        "  map.toOutput(2500),",
        "  map.toSource(2000),",
        "  fromPass.outputDurationMs,",
        "  mapped.hidden,",
        "  mapped.hiddenWords.length,",
        "  keys[0]?.scale,",
        "  snapToFrame(1010, 25),",
        '].join(" ");',
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
