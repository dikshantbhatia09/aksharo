import path from "node:path";

import { describe, expect, it } from "vitest";

import { EngineClient } from "@montaj/engine-client";

import { connectToLocalEngine, engineDiscoveryFilePath } from "./engine-connection.js";

describe("engineDiscoveryFilePath", () => {
  it("points at ~/.aksharo/engine.json", () => {
    expect(engineDiscoveryFilePath("/home/x")).toBe(
      path.join("/home/x", ".aksharo", "engine.json"),
    );
  });
});

describe("connectToLocalEngine", () => {
  it("builds a client from a valid discovery file", () => {
    const readFileFn = () =>
      JSON.stringify({
        port: 4823,
        bearer: "a".repeat(40),
        pid: 123,
        version: "0.1.0",
        startedAt: new Date().toISOString(),
      });

    const client = connectToLocalEngine({ readFileFn });
    expect(client).toBeInstanceOf(EngineClient);
  });

  it("returns null when the discovery file is missing", () => {
    const readFileFn = () => {
      throw new Error("ENOENT");
    };
    expect(connectToLocalEngine({ readFileFn })).toBeNull();
  });

  it("returns null when the discovery file is malformed", () => {
    const readFileFn = () => JSON.stringify({ port: "not a number" });
    expect(connectToLocalEngine({ readFileFn })).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    const readFileFn = () => "{not json";
    expect(connectToLocalEngine({ readFileFn })).toBeNull();
  });
});
