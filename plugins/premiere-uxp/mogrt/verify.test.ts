import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildPlaceholderMogrt } from "./build-placeholder.js";
import { generateMogrtDefinition } from "./generate.js";
import { verifyMogrtBuffer } from "./verify.js";
import { writeZipStore } from "./zip.js";

const here = dirname(fileURLToPath(import.meta.url));

function zipWithDefinition(
  definition: unknown,
  extraEntries: { name: string; data: Buffer }[] = [],
): Buffer {
  return writeZipStore([
    { name: "definition.json", data: Buffer.from(JSON.stringify(definition), "utf8") },
    ...extraEntries,
  ]);
}

describe("verifyMogrtBuffer", () => {
  it("verifies the committed placeholder.mogrt", () => {
    const buffer = readFileSync(join(here, "placeholder.mogrt"));
    const result = verifyMogrtBuffer(buffer, { allowPlaceholder: true });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.isPlaceholder).toBe(true);
    expect(result.definition?.params).toHaveLength(14);
  });

  it("rejects the placeholder when allowPlaceholder is not set", () => {
    const buffer = buildPlaceholderMogrt();
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("missing-aep");
  });

  it("passes a definition with a .aep entry present, no placeholder flag needed", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const buffer = zipWithDefinition(definition, [
      { name: "template.aep", data: Buffer.from("fake-aep-bytes") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(true);
    expect(result.isPlaceholder).toBe(false);
  });

  it("flags a .mogrt with no .aep and no placeholder flag", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const buffer = zipWithDefinition(definition);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("missing-aep");
  });

  it("flags placeholder=true with a .aep present as inconsistent", () => {
    const definition = generateMogrtDefinition({ placeholder: true });
    const buffer = zipWithDefinition(definition, [
      { name: "template.aep", data: Buffer.from("x") },
    ]);
    const result = verifyMogrtBuffer(buffer, { allowPlaceholder: true });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.kind)).toContain("unexpected-aep-on-placeholder");
  });

  it("reports a missing definition.json", () => {
    const buffer = writeZipStore([{ name: "notes.txt", data: Buffer.from("no def here") }]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ kind: "missing-definition", message: expect.any(String) }]);
  });

  it("reports invalid JSON in definition.json", () => {
    const buffer = writeZipStore([
      { name: "definition.json", data: Buffer.from("{not json", "utf8") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("invalid-json");
  });

  it("reports schema violations (missing required field)", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const { mogrtName: _drop, ...broken } = definition;
    const buffer = zipWithDefinition(broken, [{ name: "template.aep", data: Buffer.from("x") }]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("schema-invalid");
  });

  it("reports a renamed param by name and index (displayName drift)", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const params = definition.params.map((p, i) => (i === 3 ? { ...p, displayName: "Color" } : p));
    const buffer = zipWithDefinition({ ...definition, params }, [
      { name: "template.aep", data: Buffer.from("x") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    const mismatch = result.issues.find((i) => i.kind === "param-mismatch" && i.paramIndex === 3);
    expect(mismatch).toBeDefined();
    expect(mismatch?.paramName).toBe("Colour");
  });

  it("reports a reordered param set (swap two entries)", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const params = [...definition.params];
    const tmp = params[0]!;
    params[0] = { ...params[1]!, index: 0 };
    params[1] = { ...tmp, index: 1 };
    const buffer = zipWithDefinition({ ...definition, params }, [
      { name: "template.aep", data: Buffer.from("x") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.kind === "param-mismatch" && i.paramIndex === 0)).toBe(true);
    expect(result.issues.some((i) => i.kind === "param-mismatch" && i.paramIndex === 1)).toBe(true);
  });

  it("reports a param count mismatch (extra param appended)", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const params = [
      ...definition.params,
      {
        index: 14,
        name: "Extra",
        displayName: "Extra",
        type: "text" as const,
        defaultValue: "",
        description: "extra",
      },
    ];
    const buffer = zipWithDefinition({ ...definition, params }, [
      { name: "template.aep", data: Buffer.from("x") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.kind === "param-count-mismatch")).toBe(true);
  });

  it("reports not-a-zip on garbage input", () => {
    const result = verifyMogrtBuffer(Buffer.from("garbage"));
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("not-a-zip");
  });

  it("flags more than one .aep", () => {
    const definition = generateMogrtDefinition({ placeholder: false });
    const buffer = zipWithDefinition(definition, [
      { name: "a.aep", data: Buffer.from("x") },
      { name: "b.aep", data: Buffer.from("y") },
    ]);
    const result = verifyMogrtBuffer(buffer);
    expect(result.issues.some((i) => i.kind === "multiple-aep")).toBe(true);
  });
});
