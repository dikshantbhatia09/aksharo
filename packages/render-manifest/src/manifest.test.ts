import { describe, expect, it } from "vitest";

import { isRenderManifestError, RenderManifestError } from "./errors.js";
import { aspectRatio, coverScaleCrop, dimensionsFor, toEven } from "./presets.js";
import { RenderManifestSchema } from "./schema.js";
import {
  canonicalJson,
  MANIFEST_SIGNATURE_DOMAIN,
  signingPayload,
  signRenderManifest,
  verifyManifestSignature,
  withSignature,
} from "./signature.js";
import { fixtureManifest, signedFixtureManifest } from "./testing.js";
import { assertWithinCaps, capViolations, verifyRenderManifest } from "./verify.js";

const SECRET = "a20-primary-secret";
const NEXT = "a20-rotation-secret";
const NOW = Date.parse("2026-09-02T09:00:00.000Z");

describe("the schema", () => {
  it("accepts the fixture once it is signed", () => {
    const parsed = RenderManifestSchema.safeParse(signedFixtureManifest(SECRET));
    expect(parsed.success).toBe(true);
  });

  it("applies its defaults, so an issuer may omit them", () => {
    const manifest = signedFixtureManifest(SECRET);
    const relaxed = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    delete (relaxed["timemap"] as Record<string, unknown>)["snapCutsToFrames"];
    delete (relaxed["audio"] as Record<string, unknown>)["codec"];
    const parsed = RenderManifestSchema.parse(relaxed);
    expect(parsed.timemap.snapCutsToFrames).toBe(false);
    expect(parsed.audio.codec).toBe("aac");
  });

  it("refuses an id that is not a ULID", () => {
    const manifest = { ...signedFixtureManifest(SECRET), workspaceId: "not-a-ulid" };
    expect(RenderManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("refuses a version it does not know", () => {
    const manifest = { ...signedFixtureManifest(SECRET), v: 2 };
    expect(RenderManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("allows a null watermark and null subtitles", () => {
    const manifest = signedFixtureManifest(SECRET, { watermark: null, subtitles: null });
    expect(RenderManifestSchema.parse(manifest).watermark).toBeNull();
  });

  it("parses accepted text-fx titles on the timemap (D06)", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        titles: [
          {
            itemId: "01JA20TXTFX000000000000000",
            startMs: 0,
            endMs: 1200,
            text: "welcome back",
            intent: "title",
            motionPreset: "pop",
          },
        ],
      },
    });
    const parsed = RenderManifestSchema.parse(manifest);
    expect(parsed.timemap.titles).toHaveLength(1);
    expect(parsed.timemap.titles?.[0]).toMatchObject({ text: "welcome back", motionPreset: "pop" });
  });

  it("omits titles just fine — every manifest built before D06 stays valid", () => {
    const manifest = signedFixtureManifest(SECRET);
    const parsed = RenderManifestSchema.parse(manifest);
    expect(parsed.timemap.titles).toBeUndefined();
  });

  it("parses accepted sfx cues on the timemap (D04c)", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        audio: {
          sfx: [
            {
              itemId: "01JA20SFXEVENT000000000000",
              startMs: 1_000,
              endMs: 1_600,
              assetId: "01JA20ASSET000000000000000",
              packId: "fixture-pack-01",
              storageKey: "packs/fixture-pack-01/01JA20ASSET000000000000000.wav",
              gainDb: -6,
              fadeInMs: 0,
              fadeOutMs: 0,
              duck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
            },
          ],
        },
      },
    });
    const parsed = RenderManifestSchema.parse(manifest);
    expect(parsed.timemap.audio?.sfx).toHaveLength(1);
    expect(parsed.timemap.audio?.sfx?.[0]).toMatchObject({ packId: "fixture-pack-01", gainDb: -6 });
  });

  it("parses accepted music beds on the timemap (D05)", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        audio: {
          music: [
            {
              itemId: "01JA20MSCBEDEVENT000000000",
              startMs: 0,
              endMs: 20_000,
              assetId: "01JA20MSCASSET0000000000000",
              packId: "fixture-pack-01",
              storageKey: "packs/fixture-pack-01/01JA20MSCASSET0000000000000.wav",
              gainDb: -18,
              loopPolicy: "loop",
              bedDuck: { depthDb: -12, attackMs: 150, releaseMs: 150 },
              mood: ["calm"],
              bpm: 92,
            },
          ],
        },
      },
    });
    const parsed = RenderManifestSchema.parse(manifest);
    expect(parsed.timemap.audio?.music).toHaveLength(1);
    expect(parsed.timemap.audio?.music?.[0]).toMatchObject({
      packId: "fixture-pack-01",
      loopPolicy: "loop",
      bpm: 92,
    });
  });

  it("omits timemap.audio just fine — every manifest built before D04c stays valid", () => {
    const manifest = signedFixtureManifest(SECRET);
    const parsed = RenderManifestSchema.parse(manifest);
    expect(parsed.timemap.audio).toBeUndefined();
  });

  it("parses a subtitle request", () => {
    const manifest = signedFixtureManifest(SECRET, {
      subtitles: { formats: ["srt", "vtt"], scripts: ["roman"], dropFillers: true },
    });
    expect(RenderManifestSchema.parse(manifest).subtitles?.formats).toEqual(["srt", "vtt"]);
  });

  it("parses the three timemap edit kinds", () => {
    const manifest = signedFixtureManifest(SECRET, {
      timemap: {
        sourceDurationMs: 10_000,
        snapCutsToFrames: false,
        edits: [
          { kind: "cut", startMs: 1_000, endMs: 2_000 },
          { kind: "speed", startMs: 3_000, endMs: 4_000, factor: 2 },
          { kind: "hold", atMs: 5_000, durationMs: 500 },
        ],
      },
    });
    expect(RenderManifestSchema.parse(manifest).timemap.edits).toHaveLength(3);
  });
});

describe("canonical JSON", () => {
  it("sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: undefined, c: [1, "x", null] })).toBe(
      '{"b":1,"c":[1,"x",null]}',
    );
  });

  it("is insensitive to insertion order", () => {
    expect(canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(
      canonicalJson({ b: { c: 3, d: 2 }, a: 1 }),
    );
  });

  it("writes non-finite numbers as null rather than crashing", () => {
    expect(canonicalJson({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toBe(
      '{"x":null,"y":null}',
    );
  });

  it("writes anything it cannot represent as null", () => {
    expect(canonicalJson(() => 1)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("the signature", () => {
  it("is domain-separated, so it can never be replayed as a callback signature", () => {
    expect(signingPayload(fixtureManifest()).startsWith(MANIFEST_SIGNATURE_DOMAIN)).toBe(true);
  });

  it("does not depend on key order", () => {
    const manifest = fixtureManifest();
    const reordered = JSON.parse(JSON.stringify({ ...manifest, v: manifest.v })) as typeof manifest;
    const shuffled = Object.fromEntries(
      Object.entries(reordered as unknown as Record<string, unknown>).reverse(),
    ) as unknown as typeof manifest;
    expect(signRenderManifest(shuffled, SECRET)).toBe(signRenderManifest(manifest, SECRET));
  });

  it("ignores a signature field already present on the input", () => {
    const manifest = fixtureManifest();
    const withJunk = { ...manifest, signature: "deadbeef" } as typeof manifest;
    expect(signRenderManifest(withJunk, SECRET)).toBe(signRenderManifest(manifest, SECRET));
  });

  it("refuses to sign without a secret", () => {
    expect(() => signRenderManifest(fixtureManifest(), "")).toThrow(RenderManifestError);
  });

  it("verifies under the primary key", () => {
    expect(
      verifyManifestSignature({ manifest: signedFixtureManifest(SECRET), secret: SECRET }),
    ).toBe("primary");
  });

  it("verifies under the rotation key while a roll is in progress", () => {
    const manifest = signedFixtureManifest(NEXT);
    expect(verifyManifestSignature({ manifest, secret: SECRET, secretNext: NEXT })).toBe("next");
  });

  it("returns null when neither key matches", () => {
    const manifest = signedFixtureManifest("some other secret");
    expect(verifyManifestSignature({ manifest, secret: SECRET, secretNext: NEXT })).toBeNull();
  });

  it("returns null for a signature of the wrong length", () => {
    const manifest = { ...signedFixtureManifest(SECRET), signature: "ab" };
    expect(verifyManifestSignature({ manifest, secret: SECRET })).toBeNull();
  });

  it("throws when no key is configured at all", () => {
    expect(() =>
      verifyManifestSignature({ manifest: signedFixtureManifest(SECRET), secret: "" }),
    ).toThrow(/no INTERNAL_CALLBACK_SECRET/);
  });

  it("changes when any signed field changes", () => {
    const signed = signedFixtureManifest(SECRET);
    const tampered = withSignature(fixtureManifest({ watermark: null }), SECRET);
    expect(tampered.signature).not.toBe(signed.signature);
  });
});

describe("verifyRenderManifest", () => {
  it("returns the parsed manifest and the key that verified it", () => {
    const result = verifyRenderManifest({
      manifest: signedFixtureManifest(SECRET),
      secret: SECRET,
      now: NOW,
    });
    expect(result.key).toBe("primary");
    expect(result.manifest.output.width).toBe(1080);
  });

  it("refuses a malformed document with manifest/malformed", () => {
    try {
      verifyRenderManifest({ manifest: { v: 1 }, secret: SECRET, now: NOW });
      expect.unreachable("a bare {v:1} must not verify");
    } catch (error) {
      expect(isRenderManifestError(error, "manifest/malformed")).toBe(true);
      expect((error as RenderManifestError).detail["issues"]).toBeInstanceOf(Array);
    }
  });

  it("refuses a tampered watermark decision with manifest/bad-signature", () => {
    // The exact attack THREAT-MODEL T10 names: strip the watermark from a
    // manifest the server issued with one.
    const signed = signedFixtureManifest(SECRET);
    const tampered = { ...signed, watermark: null };
    const error = catchError(() => {
      verifyRenderManifest({ manifest: tampered, secret: SECRET, now: NOW });
    });
    expect(isRenderManifestError(error, "manifest/bad-signature")).toBe(true);
  });

  it("refuses a raised cap with manifest/bad-signature", () => {
    const signed = signedFixtureManifest(SECRET);
    const tampered = { ...signed, caps: { ...signed.caps, maxWidth: 7680, allowAlpha: true } };
    expect(
      isRenderManifestError(
        catchError(() => {
          verifyRenderManifest({ manifest: tampered, secret: SECRET, now: NOW });
        }),
        "manifest/bad-signature",
      ),
    ).toBe(true);
  });

  it("refuses an expired manifest", () => {
    const error = catchError(() => {
      verifyRenderManifest({
        manifest: signedFixtureManifest(SECRET),
        secret: SECRET,
        now: NOW + 2 * 60 * 60_000,
      });
    });
    expect(isRenderManifestError(error, "manifest/expired")).toBe(true);
  });

  it("refuses a manifest issued beyond the clock-skew allowance", () => {
    const error = catchError(() => {
      verifyRenderManifest({
        manifest: signedFixtureManifest(SECRET),
        secret: SECRET,
        now: NOW - 30 * 60_000,
      });
    });
    expect(isRenderManifestError(error, "manifest/not-yet-valid")).toBe(true);
  });

  it("tolerates small skew inside the window", () => {
    expect(
      verifyRenderManifest({
        manifest: signedFixtureManifest(SECRET),
        secret: SECRET,
        now: NOW - 60_000,
      }).manifest.manifestId,
    ).toBeTruthy();
  });

  it("uses the wall clock when no `now` is given", () => {
    const manifest = signedFixtureManifest(SECRET, {}, Date.now());
    expect(verifyRenderManifest({ manifest, secret: SECRET }).key).toBe("primary");
  });
});

describe("caps", () => {
  it("passes a render inside its entitlement", () => {
    const manifest = signedFixtureManifest(SECRET);
    expect(capViolations(manifest, 10_000)).toEqual([]);
    expect(() => {
      assertWithinCaps(manifest, 10_000);
    }).not.toThrow();
  });

  it("refuses 4K on a 1080p entitlement, naming every breach", () => {
    const manifest = signedFixtureManifest(SECRET, {
      output: {
        kind: "video",
        preset: "youtube-4k",
        aspect: "16:9",
        width: 3840,
        height: 2160,
        fps: 60,
        container: "mp4",
        videoCodec: "h264",
        crf: 18,
        encoderPreset: "veryfast",
      },
    });
    const violations = capViolations(manifest, 10_000);
    expect(violations.map((violation) => violation.cap).sort()).toEqual(["maxHeight", "maxWidth"]);
    const error = catchError(() => {
      assertWithinCaps(manifest, 10_000);
    });
    expect(isRenderManifestError(error, "manifest/caps-exceeded")).toBe(true);
    expect((error as RenderManifestError).message).toContain("maxWidth 3840 > 1920");
  });

  it("measures duration after the timemap, not before", () => {
    const manifest = signedFixtureManifest(SECRET, {
      caps: {
        maxWidth: 1920,
        maxHeight: 1920,
        maxDurationMs: 5_000,
        maxFps: 60,
        allowAlpha: false,
      },
    });
    expect(capViolations(manifest, 4_000)).toEqual([]);
    expect(capViolations(manifest, 6_000).map((violation) => violation.cap)).toEqual([
      "maxDurationMs",
    ]);
  });

  it("refuses an fps above the cap", () => {
    const manifest = signedFixtureManifest(SECRET, {
      caps: {
        maxWidth: 1920,
        maxHeight: 1920,
        maxDurationMs: 60_000,
        maxFps: 30,
        allowAlpha: true,
      },
      output: {
        kind: "video",
        preset: "reels",
        aspect: "9:16",
        width: 1080,
        height: 1920,
        fps: 60,
        container: "mp4",
        videoCodec: "h264",
      },
    });
    expect(capViolations(manifest, 10_000).map((violation) => violation.cap)).toEqual(["maxFps"]);
  });

  it("refuses an alpha export the plan does not include", () => {
    const manifest = signedFixtureManifest(SECRET, {
      output: {
        kind: "alpha",
        preset: "reels",
        aspect: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        container: "mov",
        videoCodec: "prores4444",
      },
    });
    expect(capViolations(manifest, 10_000).map((violation) => violation.cap)).toEqual([
      "allowAlpha",
    ]);
  });

  it("allows an alpha export when the plan does include it", () => {
    const manifest = signedFixtureManifest(SECRET, {
      caps: {
        maxWidth: 1920,
        maxHeight: 1920,
        maxDurationMs: 60_000,
        maxFps: 60,
        allowAlpha: true,
      },
      output: {
        kind: "alpha",
        preset: "reels",
        aspect: "9:16",
        width: 1080,
        height: 1920,
        fps: 30,
        container: "mov",
        videoCodec: "prores4444",
      },
    });
    expect(capViolations(manifest, 10_000)).toEqual([]);
  });
});

describe("presets", () => {
  it("knows the four named sizes and says nothing about custom", () => {
    expect(dimensionsFor("reels")).toMatchObject({ width: 1080, height: 1920, aspect: "9:16" });
    expect(dimensionsFor("youtube-4k")).toMatchObject({ width: 3840, height: 2160 });
    expect(dimensionsFor("square")).toMatchObject({ width: 1080, height: 1080 });
    expect(dimensionsFor("shorts")?.aspect).toBe("9:16");
    expect(dimensionsFor("custom")).toBeNull();
  });

  // K07: Instagram Story shares reels' exact canvas; Instagram Feed is the
  // first preset to use the 4:5 aspect `ASPECT_RATIOS` already carried.
  it("knows the K07 Instagram Story and Instagram Feed sizes", () => {
    expect(dimensionsFor("instagram-story")).toMatchObject({
      width: 1080,
      height: 1920,
      aspect: "9:16",
    });
    // Same canvas as `reels` (width/height/aspect) — the label is
    // deliberately different (see `RENDER_PRESETS`'s doc comment), so this
    // compares only the pixel-relevant fields, not the whole object.
    const story = dimensionsFor("instagram-story");
    const reels = dimensionsFor("reels");
    expect(story).not.toBeNull();
    expect(reels).not.toBeNull();
    expect({ width: story?.width, height: story?.height, aspect: story?.aspect }).toEqual({
      width: reels?.width,
      height: reels?.height,
      aspect: reels?.aspect,
    });
    expect(story?.label).not.toBe(reels?.label);
    expect(dimensionsFor("instagram-feed")).toMatchObject({
      width: 1080,
      height: 1350,
      aspect: "4:5",
    });
  });

  it("ships only even dimensions, because 4:2:0 halves both axes", () => {
    for (const preset of [
      "reels",
      "shorts",
      "youtube-4k",
      "square",
      "instagram-story",
      "instagram-feed",
    ] as const) {
      const dimensions = dimensionsFor(preset);
      expect(dimensions).not.toBeNull();
      expect((dimensions?.width ?? 1) % 2).toBe(0);
      expect((dimensions?.height ?? 1) % 2).toBe(0);
    }
  });

  it("reports aspect ratios that match the named dimensions", () => {
    expect(aspectRatio("9:16")).toBeCloseTo(1080 / 1920, 10);
    expect(aspectRatio("16:9")).toBeCloseTo(3840 / 2160, 10);
    expect(aspectRatio("1:1")).toBe(1);
    expect(aspectRatio("4:5")).toBeCloseTo(0.8, 10);
  });

  it("rounds down to even with a floor of 2", () => {
    expect(toEven(1081)).toBe(1080);
    expect(toEven(1080)).toBe(1080);
    expect(toEven(0)).toBe(2);
    expect(toEven(-4)).toBe(2);
  });

  it("is the identity when the source already matches", () => {
    const fit = coverScaleCrop(1080, 1920, 1080, 1920);
    expect(fit.identity).toBe(true);
    expect(fit.cropX).toBe(0);
    expect(fit.cropY).toBe(0);
  });

  it("crops the sides when a 16:9 source becomes a 9:16 Reel", () => {
    const fit = coverScaleCrop(1920, 1080, 1080, 1920);
    expect(fit.identity).toBe(false);
    expect(fit.scaleHeight).toBeGreaterThanOrEqual(1920);
    expect(fit.cropWidth).toBe(1080);
    expect(fit.cropHeight).toBe(1920);
    expect(fit.cropX).toBeGreaterThan(0);
    expect(fit.cropY).toBe(0);
  });

  it("crops the top and bottom when a 9:16 source becomes a 16:9 master", () => {
    const fit = coverScaleCrop(1080, 1920, 1920, 1080);
    expect(fit.cropY).toBeGreaterThan(0);
    expect(fit.cropX).toBe(0);
  });

  it("never scales smaller than the crop window", () => {
    for (const [w, h] of [
      [1281, 721],
      [641, 361],
      [1999, 1001],
    ] as const) {
      const fit = coverScaleCrop(w, h, 1080, 1920);
      expect(fit.scaleWidth).toBeGreaterThanOrEqual(fit.cropWidth);
      expect(fit.scaleHeight).toBeGreaterThanOrEqual(fit.cropHeight);
      expect(fit.scaleWidth % 2).toBe(0);
      expect(fit.scaleHeight % 2).toBe(0);
    }
  });

  it("refuses a source with no pixels", () => {
    expect(() => coverScaleCrop(0, 100, 10, 10)).toThrow(RangeError);
  });
});

/** Runs `body` and returns whatever it threw, so a test can assert on the code. */
function catchError(body: () => void): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("expected the body to throw");
}
