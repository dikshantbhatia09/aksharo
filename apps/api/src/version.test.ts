import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_VERSION } from "./version.js";

describe("APP_VERSION", () => {
  it("matches package.json, so /health never reports a stale version", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(APP_VERSION).toBe(manifest["version"]);
  });
});
