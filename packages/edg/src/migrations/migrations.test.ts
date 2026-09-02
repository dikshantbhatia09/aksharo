import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { restore, toProjection } from "../ops/index.js";
import { validateProjection } from "../validate.js";
import { migrate, MIGRATIONS, schemaVersionOf } from "./migrate.js";
import { CHUNK_MS, EdgV1DocumentSchema, MigrationError, migrateV1ToV2 } from "./v1.js";

const FIXTURES = join(__dirname, "..", "..", "fixtures");
const legacy = JSON.parse(
  readFileSync(join(FIXTURES, "legacy-v1-document.json"), "utf8"),
) as Record<string, unknown>;

function v1(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
}

const parsed = EdgV1DocumentSchema.parse(legacy);

describe("the v1 fixture", () => {
  it("migrates to a valid v2 snapshot", () => {
    const snapshot = migrate(v1());
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.projection.meta.schemaVersion).toBe(2);
    expect(
      validateProjection(snapshot.projection, {
        wordIndex: restore(snapshot).words,
      }),
    ).toEqual([]);
  });

  it("hands every word a stable id from the chunk it was stored in", () => {
    const snapshot = migrate(v1());
    expect(snapshot.chunks?.map((chunk) => chunk.chunkIdx)).toEqual([0, 1]);
    expect(snapshot.chunks?.[0]?.words.map((word) => word.wid)).toEqual([
      "0:0",
      "0:1",
      "0:2",
      "0:3",
      "0:4",
      "0:5",
      "0:6",
      "0:7",
    ]);
    expect(snapshot.chunks?.[1]?.words.map((word) => word.wid)).toEqual([
      "1:0",
      "1:1",
      "1:2",
      "1:3",
      "1:4",
      "1:5",
    ]);
  });

  it("keeps every segment's text and timing exactly as v1 had it", () => {
    const snapshot = migrate(v1());
    const words = (snapshot.chunks ?? []).flatMap((chunk) => chunk.words);
    for (const [index, before] of parsed.segments.entries()) {
      const after = snapshot.projection.segments[index];
      expect(after, `segment ${index}`).toBeDefined();
      if (after === undefined) continue;

      const [from, to] = before.wordRange;
      expect(after.startMs).toBe(before.startMs ?? parsed.words[from]?.s);
      expect(after.endMs).toBe(before.endMs ?? parsed.words[to]?.e);
      expect(after.startWordId).toBe(words[from]?.wid);
      expect(after.endWordId).toBe(words[to]?.wid);

      // The words a caption renders, before and after.
      expect(words.slice(from, to + 1).map((word) => word.t)).toEqual(
        parsed.words.slice(from, to + 1).map((word) => word.t),
      );
      const expectedText = before.text ?? before.textOverrides?.["roman"];
      if (expectedText !== undefined) expect(after.textOverrides?.["roman"]).toBe(expectedText);
      if (before.textOverrides?.["native"] !== undefined) {
        expect(after.textOverrides?.["native"]).toBe(before.textOverrides["native"]);
      }
      expect(after.styleRef).toBe(before.styleRef);
      expect(after.position).toEqual(before.position);
      expect(after.overrides).toEqual(before.overrides);
      expect(after.hidden).toBe(before.hidden === true ? true : undefined);
    }
  });

  it("rewrites emphasis from a word index to a word id", () => {
    const snapshot = migrate(v1());
    expect(snapshot.projection.segments[0]?.emphasis).toEqual([{ wordId: "0:2", presetId: "pop" }]);
  });

  it("gives the segments ascending seq keys and keeps their order", () => {
    const snapshot = migrate(v1());
    const seqs = snapshot.projection.segments.map((segment) => segment.seq);
    expect([...seqs].sort()).toEqual(seqs);
    expect(snapshot.projection.segments.map((segment) => segment.id)).toEqual(
      parsed.segments.map((segment) => segment.id),
    );
  });

  it("restores into a state whose ops can address the migrated words", () => {
    const snapshot = migrate(v1());
    const state = restore(snapshot);
    expect(state.words.size).toBe(parsed.words.length);
    expect(toProjection(state)).toEqual(snapshot.projection);
  });

  it("falls back to 10-minute windows when v1 stored no chunk sizes", () => {
    const withSizes = migrate(v1());
    const document = v1();
    delete document["chunkSizes"];
    const byTime = migrate(document);
    expect(byTime.projection.segments).toEqual(withSizes.projection.segments);
    expect(byTime.chunks?.map((chunk) => chunk.words.map((word) => word.wid))).toEqual(
      withSizes.chunks?.map((chunk) => chunk.words.map((word) => word.wid)),
    );
    expect(byTime.chunks?.[1]?.startMs).toBe(CHUNK_MS);
  });
});

describe("migrate", () => {
  it("returns a document that is already current", () => {
    const snapshot = migrate(v1());
    expect(migrate(snapshot)).toEqual(snapshot);
  });

  it("refuses to go backwards or across a gap in the chain", () => {
    const snapshot = migrate(v1());
    expect(() => migrate(snapshot, 1)).toThrow(/down to v1/);
    expect(() => migrate(v1(), 3)).toThrow(/no migration is registered from v2/);
  });

  it("registers the v1 to v2 step", () => {
    expect(MIGRATIONS.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
  });

  it("rejects a document that declares no version", () => {
    expect(() => migrate({})).toThrow(MigrationError);
    expect(() => migrate("nope")).toThrow(/must be an object/);
  });

  it("reads the version from the top level, from meta or from a projection", () => {
    expect(schemaVersionOf({ schemaVersion: 1 })).toBe(1);
    expect(schemaVersionOf({ meta: { schemaVersion: 2 } })).toBe(2);
    expect(schemaVersionOf({ projection: { meta: { schemaVersion: 2 } } })).toBe(2);
  });

  it("reports a step that produced something that is not a v2 snapshot", () => {
    expect(() =>
      migrate(v1(), 2, [
        { from: 1, to: 2, description: "deliberately broken", migrate: () => ({}) },
      ]),
    ).toThrow(/produced an invalid v2 snapshot/);
  });

  it("rewrites B10's b10:<cleanId> preset encoding to SetAudio.clean.cleanId (B10b)", () => {
    const snapshot = migrate(v1());
    const withLegacyPreset = {
      ...snapshot,
      projection: {
        ...snapshot.projection,
        audio: { clean: { enabled: true, preset: "b10:01HXYZYYYYYYYYYYYYYYYYYYYY" } },
      },
    };
    const migrated = migrate(withLegacyPreset);
    expect(migrated.projection.audio).toEqual({
      clean: { enabled: true, cleanId: "01HXYZYYYYYYYYYYYYYYYYYYYY" },
    });
  });

  it("leaves a non-B10 preset and an already-first-class cleanId alone", () => {
    const snapshot = migrate(v1());
    const withOtherPreset = {
      ...snapshot,
      projection: {
        ...snapshot.projection,
        audio: { clean: { enabled: true, preset: "podcast", targetLufs: -14 } },
      },
    };
    expect(migrate(withOtherPreset).projection.audio).toEqual({
      clean: { enabled: true, preset: "podcast", targetLufs: -14 },
    });

    const withCleanId = {
      ...snapshot,
      projection: {
        ...snapshot.projection,
        audio: { clean: { enabled: true, cleanId: "01HXYZYYYYYYYYYYYYYYYYYYYY" } },
      },
    };
    expect(migrate(withCleanId).projection.audio).toEqual({
      clean: { enabled: true, cleanId: "01HXYZYYYYYYYYYYYYYYYYYYYY" },
    });
  });
});

describe("migrateV1ToV2 rejects a document it cannot carry forward", () => {
  it("refuses a non-v1 document", () => {
    expect(() => migrateV1ToV2({ schemaVersion: 2 })).toThrow(/not a v1 EDG document/);
  });

  it("refuses a backwards word range", () => {
    const document = v1();
    (document["segments"] as { wordRange: number[] }[])[0] = {
      ...(document["segments"] as { wordRange: number[] }[])[0],
      wordRange: [3, 1],
    } as { wordRange: number[] };
    expect(() => migrateV1ToV2(document)).toThrow(/backwards wordRange/);
  });

  it("refuses a word range past the end of the transcript", () => {
    const document = v1();
    (document["segments"] as { wordRange: number[] }[])[3] = {
      ...(document["segments"] as { wordRange: number[] }[])[3],
      wordRange: [11, 99],
    } as { wordRange: number[] };
    expect(() => migrateV1ToV2(document)).toThrow(/past the end of the transcript/);
  });

  it("refuses emphasis pointing past the end of the transcript", () => {
    const document = v1();
    const segments = document["segments"] as { emphasis?: unknown }[];
    const first = segments[0];
    if (first !== undefined) first.emphasis = [{ wordIndex: 99, presetId: "pop" }];
    expect(() => migrateV1ToV2(document)).toThrow(/emphasis points at word 99/);
  });

  it("refuses chunk sizes that do not account for every word", () => {
    const document = v1();
    document["chunkSizes"] = [4, 4];
    expect(() => migrateV1ToV2(document)).toThrow(/account for fewer words/);
  });

  it("derives times from the words when v1 left them implicit", () => {
    const snapshot = migrate(v1());
    const second = snapshot.projection.segments[1];
    expect(second?.startMs).toBe(parsed.words[4]?.s);
    expect(second?.endMs).toBe(parsed.words[7]?.e);
  });
});

describe("a v1 document that left the optional fields out", () => {
  it("migrates without inventing engine versions, speakers or scripts", () => {
    const document = v1();
    delete (document["meta"] as Record<string, unknown>)["engineVersions"];
    const transcript = document["transcript"] as Record<string, unknown>;
    delete transcript["speakers"];
    delete transcript["scripts"];
    delete document["audio"];
    delete document["render"];
    delete document["passes"];
    const snapshot = migrate(document);
    expect(snapshot.projection.meta.engineVersions).toBeUndefined();
    expect(snapshot.projection.transcript.speakers).toBeUndefined();
    expect(snapshot.projection.transcript.scripts).toEqual(["roman"]);
    expect(snapshot.projection.audio).toBeUndefined();
    expect(snapshot.projection.render).toBeUndefined();
    expect(snapshot.projection.passes).toEqual([]);
    // The v1 `text` still lands on the first script of the transcript.
    expect(snapshot.projection.segments[0]?.textOverrides).toEqual({
      roman: "Bhai aaj hum baat",
    });
  });
});
