import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateMogrtDefinition } from "./generate.js";
import { MOGRT_PARAM_NAMES } from "./params.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "definition.golden.json"), "utf8"));

describe("generateMogrtDefinition", () => {
  it("matches the golden fixture exactly (non-placeholder)", () => {
    expect(generateMogrtDefinition({ placeholder: false })).toEqual(golden);
  });

  it("produces the frozen param order and names, 14 params", () => {
    const { params } = generateMogrtDefinition({ placeholder: false });
    expect(params).toHaveLength(14);
    expect(params.map((p) => p.name)).toEqual([...MOGRT_PARAM_NAMES]);
    params.forEach((param, i) => {
      expect(param.index).toBe(i);
      // displayName equals name today; index fallback in C06 depends on this
      // staying true, or on both being documented if they ever diverge.
      expect(param.displayName).toBe(param.name);
    });
  });

  it("is deterministic across calls", () => {
    expect(generateMogrtDefinition({ placeholder: false })).toEqual(
      generateMogrtDefinition({ placeholder: false }),
    );
  });

  it("sets placeholder per the option", () => {
    expect(generateMogrtDefinition({ placeholder: true }).placeholder).toBe(true);
    expect(generateMogrtDefinition({ placeholder: false }).placeholder).toBe(false);
  });
});
