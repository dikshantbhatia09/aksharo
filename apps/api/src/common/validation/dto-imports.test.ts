import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every `@Body()`/`@Query()` DTO a controller takes is imported as a VALUE
 * (2026-09-29).
 *
 * `ZodValidationPipe` finds a parameter's schema on the class TypeScript
 * writes into the decorator metadata. A type-only import (`import type`, or
 * `type X` inside an import) leaves that metadata as `Object`, and the pipe
 * then validates nothing: ten routes in `affiliates` and `billing` took their
 * bodies unchecked that way, a public one among them, with every test green.
 */
const SRC = join(__dirname, "..", "..");
// Prettier writes every such parameter as `@Body() name: Type`.
const PARAM = /@(Body|Query)\(\) \w+: ([A-Z]\w*)/g;
const TYPE_BLOCK = /import\s+type\s*\{([^}]*)\}\s*from/g;
const MIXED_BLOCK = /import\s*\{([^}]*)\}\s*from/g;

function controllers(dir: string): string[] {
  const found: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under src/ that this test walks, not input
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under src/ that this test walks, not input
    if (statSync(path).isDirectory()) found.push(...controllers(path));
    else if (name.endsWith(".controller.ts")) found.push(path);
  }
  return found;
}

function typeOnlyImports(source: string): Set<string> {
  const names = new Set<string>();
  for (const block of source.matchAll(TYPE_BLOCK)) {
    for (const part of (block[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  for (const block of source.matchAll(MIXED_BLOCK)) {
    for (const part of (block[1] ?? "").split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("type ")) {
        const name = trimmed
          .slice(5)
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

describe("controller DTOs are value imports", () => {
  it("imports every @Body()/@Query() DTO as a value, so its schema is applied", () => {
    const offenders: string[] = [];
    for (const file of controllers(SRC)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under src/ that this test walks, not input
      const source = readFileSync(file, "utf8");
      const typeOnly = typeOnlyImports(source);
      for (const match of source.matchAll(PARAM)) {
        const type = match[2] ?? "";
        if (typeOnly.has(type)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${String(line)} @${match[1] ?? ""}() ${type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
