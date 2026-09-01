import { describe, expect, it } from "vitest";

import { cutEdit, holdEdit, speedEdit } from "./edits.js";
import { isTimeMapError, TimeMapError } from "./errors.js";
import { parseTimeMap, stringifyTimeMap } from "./serialise.js";
import { buildTimeMap, TIMEMAP_FORMAT_VERSION } from "./timemap.js";

const built = () =>
  buildTimeMap({
    sourceDurationMs: 10_000,
    fps: 25,
    edits: [
      cutEdit(2000, 3000),
      cutEdit(2500, 3500),
      speedEdit(5000, 6000, 2),
      holdEdit(7000, 400),
    ],
  });

describe("serialize", () => {
  it("writes a versioned document with the normalised edits", () => {
    expect(built().serialize()).toEqual({
      v: TIMEMAP_FORMAT_VERSION,
      sourceDurationMs: 10_000,
      fps: 25,
      edits: [
        { kind: "cut", startMs: 2000, endMs: 3500 },
        { kind: "speed", startMs: 5000, endMs: 6000, factor: 2 },
        { kind: "hold", atMs: 7000, durationMs: 400 },
      ],
    });
  });

  it("leaves fps out when the map has none", () => {
    expect(buildTimeMap({ sourceDurationMs: 10 }).serialize()).toEqual({
      v: TIMEMAP_FORMAT_VERSION,
      sourceDurationMs: 10,
      edits: [],
    });
  });

  it("is JSON-safe", () => {
    const map = built();
    expect(JSON.parse(stringifyTimeMap(map))).toEqual(map.serialize());
  });
});

describe("parseTimeMap", () => {
  it("round-trips a map exactly", () => {
    const map = built();
    const reparsed = parseTimeMap(map.serialize());
    expect(reparsed.serialize()).toEqual(map.serialize());
    expect(reparsed.spans).toEqual(map.spans);
    expect(reparsed.outputDurationMs).toBe(map.outputDurationMs);
    expect(reparsed.fps).toBe(25);
  });

  it("is a fixed point: serialising twice changes nothing", () => {
    const once = built().serialize();
    expect(parseTimeMap(parseTimeMap(once).serialize()).serialize()).toEqual(once);
  });

  it("accepts a JSON string", () => {
    const map = built();
    expect(parseTimeMap(stringifyTimeMap(map)).outputDurationMs).toBe(map.outputDurationMs);
  });

  it("rejects a document from another format version", () => {
    expect(() => parseTimeMap({ v: 2, sourceDurationMs: 1, edits: [] })).toThrowError(TimeMapError);
    try {
      parseTimeMap({ v: 99, sourceDurationMs: 1, edits: [] });
    } catch (error) {
      expect(isTimeMapError(error, "unsupported-version")).toBe(true);
    }
  });

  it("rejects a malformed envelope", () => {
    const cases: unknown[] = [
      null,
      [],
      "not json at all but a string",
      { v: TIMEMAP_FORMAT_VERSION, sourceDurationMs: "10", edits: [] },
      { v: TIMEMAP_FORMAT_VERSION, sourceDurationMs: 10, edits: {} },
      { v: TIMEMAP_FORMAT_VERSION, sourceDurationMs: 10, edits: [], fps: "25" },
      { v: TIMEMAP_FORMAT_VERSION, sourceDurationMs: 10, edits: [null] },
      { v: TIMEMAP_FORMAT_VERSION, sourceDurationMs: 10, edits: [{ kind: "warp" }] },
    ];
    for (const document of cases) {
      expect(() => parseTimeMap(document), JSON.stringify(document)).toThrowError(TimeMapError);
    }
    try {
      parseTimeMap([]);
    } catch (error) {
      expect(isTimeMapError(error, "malformed-document")).toBe(true);
    }
  });

  it("puts a bad edit value through the same validation a hand-built map gets", () => {
    expect(() =>
      parseTimeMap({
        v: TIMEMAP_FORMAT_VERSION,
        sourceDurationMs: 10,
        edits: [{ kind: "cut", startMs: 5, endMs: 1 }],
      }),
    ).toThrowError(TimeMapError);
    expect(() =>
      parseTimeMap({
        v: TIMEMAP_FORMAT_VERSION,
        sourceDurationMs: 10,
        edits: [{ kind: "speed", startMs: 0, endMs: 5, factor: 0 }],
      }),
    ).toThrowError(TimeMapError);
    expect(() =>
      parseTimeMap({
        v: TIMEMAP_FORMAT_VERSION,
        sourceDurationMs: 10,
        edits: [{ kind: "hold", atMs: -1, durationMs: 5 }],
      }),
    ).toThrowError(TimeMapError);
  });

  it("reads every edit kind back", () => {
    const map = parseTimeMap({
      v: TIMEMAP_FORMAT_VERSION,
      sourceDurationMs: 1000,
      edits: [
        { kind: "cut", startMs: 100, endMs: 200 },
        { kind: "speed", startMs: 300, endMs: 400, factor: 0.5 },
        { kind: "hold", atMs: 500, durationMs: 50 },
      ],
    });
    expect(map.cuts).toHaveLength(1);
    expect(map.speeds).toHaveLength(1);
    expect(map.holds).toHaveLength(1);
    expect(map.outputDurationMs).toBe(1000 - 100 + 100 + 50);
  });
});
