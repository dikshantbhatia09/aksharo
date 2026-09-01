import { TimeMapError } from "./errors.js";
import { buildTimeMap, TIMEMAP_FORMAT_VERSION } from "./timemap.js";

import type { Edit } from "./edits.js";
import type { SerialisedTimeMap, TimeMap } from "./timemap.js";

function malformed(message: string, detail: Record<string, unknown> = {}): never {
  throw new TimeMapError("malformed-document", message, detail);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    malformed(`${label} must be an object`, { label, value });
  }
  return value as Record<string, unknown>;
}

function readEdit(value: unknown, index: number): Edit {
  const edit = asRecord(value, `edits[${index}]`);
  switch (edit["kind"]) {
    case "cut":
      return {
        kind: "cut",
        startMs: edit["startMs"] as number,
        endMs: edit["endMs"] as number,
      };
    case "speed":
      return {
        kind: "speed",
        startMs: edit["startMs"] as number,
        endMs: edit["endMs"] as number,
        factor: edit["factor"] as number,
      };
    case "hold":
      return {
        kind: "hold",
        atMs: edit["atMs"] as number,
        durationMs: edit["durationMs"] as number,
      };
    default:
      return malformed(`edits[${index}].kind is not a known edit kind`, { kind: edit["kind"] });
  }
}

/**
 * Rebuilds a `TimeMap` from `serialize()` output (or the JSON string of it).
 *
 * The field values themselves are validated by `buildTimeMap`, so a document with
 * a fractional millisecond or a negative factor fails with the same typed error a
 * hand-built map would. Only the envelope is checked here.
 */
export function parseTimeMap(input: unknown): TimeMap {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input) as unknown;
    } catch (error) {
      malformed("document is not valid JSON", { reason: (error as Error).message });
    }
  }
  const document = asRecord(raw, "document");

  const version = document["v"];
  if (version !== TIMEMAP_FORMAT_VERSION) {
    throw new TimeMapError(
      "unsupported-version",
      `timemap document version ${String(version)} is not supported (this build reads ${TIMEMAP_FORMAT_VERSION})`,
      { version, supported: TIMEMAP_FORMAT_VERSION },
    );
  }

  const sourceDurationMs = document["sourceDurationMs"];
  if (typeof sourceDurationMs !== "number") {
    malformed("sourceDurationMs must be a number", { sourceDurationMs });
  }

  const editsValue = document["edits"];
  if (!Array.isArray(editsValue)) malformed("edits must be an array", { edits: editsValue });

  const fps = document["fps"];
  if (fps !== undefined && typeof fps !== "number") malformed("fps must be a number", { fps });

  return buildTimeMap({
    sourceDurationMs,
    edits: (editsValue as unknown[]).map(readEdit),
    ...(fps === undefined ? {} : { fps: fps as number }),
  });
}

/** `serialize()` output as a JSON string. */
export function stringifyTimeMap(map: TimeMap): string {
  return JSON.stringify(map.serialize());
}

export type { SerialisedTimeMap };
