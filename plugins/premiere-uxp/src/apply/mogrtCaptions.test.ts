import { describe, expect, it } from "vitest";

import {
  computeWordHighlightWindows,
  insertCaptionMogrts,
  paramsByIndex,
  resolveMogrtParams,
  runMogrtSelfTest,
} from "./mogrtCaptions.js";
import { MOGRT_PARAM_ORDER } from "./types.js";
import { MockPremiereHost } from "../host/premiere.js";

describe("resolveMogrtParams", () => {
  it("keeps only defined appendix-table params, in table order", () => {
    const resolved = resolveMogrtParams({ Text: "Hi", Size: 40, StyleId: "bold-pop" });
    expect(Object.keys(resolved)).toEqual(["Text", "Size", "StyleId"]);
    expect(resolved).toEqual({ Text: "Hi", Size: 40, StyleId: "bold-pop" });
  });
});

describe("paramsByIndex", () => {
  it("returns one slot per appendix param name, undefined where unset", () => {
    const values = paramsByIndex({ Text: "Hi" });
    expect(values).toHaveLength(MOGRT_PARAM_ORDER.length);
    expect(values[0]).toBe("Hi");
    expect(values[1]).toBeUndefined();
  });
});

describe("computeWordHighlightWindows", () => {
  it("computes windows relative to the segment start", () => {
    const windows = computeWordHighlightWindows(100, [
      { wid: "0:0", startFrames: 100, endFrames: 110 },
      { wid: "0:1", startFrames: 110, endFrames: 125 },
    ]);
    expect(windows).toEqual([
      { wid: "0:0", highlightStartFrames: 0, highlightEndFrames: 10 },
      { wid: "0:1", highlightStartFrames: 10, highlightEndFrames: 25 },
    ]);
  });
});

describe("insertCaptionMogrts", () => {
  it("inserts one MOGRT per segment with resolved params", async () => {
    const host = new MockPremiereHost();
    const inserted = await insertCaptionMogrts(host, {
      mogrtPath: "aksharo-captions.mogrt",
      trackIndex: 2,
      segments: [
        { startFrames: 0, endFrames: 50, params: { Text: "Hello" } },
        { startFrames: 50, endFrames: 90, params: { Text: "World", Size: 30 } },
      ],
    });

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.durationFrames).toBe(50);
    await expect(host.getMogrtParams(inserted[0]!.itemId)).resolves.toEqual({ Text: "Hello" });
    await expect(host.getMogrtParams(inserted[1]!.itemId)).resolves.toEqual({
      Text: "World",
      Size: 30,
    });
  });
});

describe("runMogrtSelfTest", () => {
  it("passes against MockPremiereHost and cleans up the scratch instance", async () => {
    const host = new MockPremiereHost();
    const result = await runMogrtSelfTest(host, "aksharo-captions.mogrt");
    expect(result.ok).toBe(true);
    await expect(host.listAksharoItems()).resolves.toEqual([]);
  });

  it("reports failure with a clear message when insertMogrt throws", async () => {
    const host = new MockPremiereHost();
    const originalInsert = host.insertMogrt.bind(host);
    host.insertMogrt = () => {
      throw new Error("no such .mogrt on disk");
    };
    const result = await runMogrtSelfTest(host, "missing.mogrt");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no such .mogrt on disk");
    host.insertMogrt = originalInsert;
  });

  it("reports failure when the readback does not match what was written", async () => {
    const host = new MockPremiereHost();
    const originalGet = host.getMogrtParams.bind(host);
    host.getMogrtParams = async () => ({ Text: "wrong" });
    const result = await runMogrtSelfTest(host, "aksharo-captions.mogrt");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not read back unchanged/);
    host.getMogrtParams = originalGet;
  });
});
