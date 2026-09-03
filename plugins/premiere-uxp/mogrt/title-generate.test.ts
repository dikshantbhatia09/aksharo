import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateTitleMogrtDefinition, TITLE_MOGRT_NAME } from "./generate.js";
import { TITLE_PARAM_NAMES } from "./title-params.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "title-definition.golden.json"), "utf8"));

describe("generateTitleMogrtDefinition", () => {
  it("matches the golden fixture exactly (non-placeholder)", () => {
    expect(generateTitleMogrtDefinition({ placeholder: false })).toEqual(golden);
  });

  it("is a distinct MOGRT from the caption one", () => {
    expect(generateTitleMogrtDefinition({ placeholder: false }).mogrtName).toBe(TITLE_MOGRT_NAME);
    expect(TITLE_MOGRT_NAME).not.toBe("Aksharo Caption");
  });

  it("reuses the frozen 14 caption params verbatim, then appends MotionPreset (15 total)", () => {
    const { params } = generateTitleMogrtDefinition({ placeholder: false });
    expect(params).toHaveLength(15);
    expect(params.map((p) => p.name)).toEqual([...TITLE_PARAM_NAMES]);
    params.forEach((param, i) => {
      expect(param.index).toBe(i);
    });
    expect(params[14]).toMatchObject({ name: "MotionPreset", type: "text", defaultValue: "fade" });
  });

  it("is deterministic across calls", () => {
    expect(generateTitleMogrtDefinition({ placeholder: false })).toEqual(
      generateTitleMogrtDefinition({ placeholder: false }),
    );
  });

  it("sets placeholder per the option", () => {
    expect(generateTitleMogrtDefinition({ placeholder: true }).placeholder).toBe(true);
    expect(generateTitleMogrtDefinition({ placeholder: false }).placeholder).toBe(false);
  });
});
