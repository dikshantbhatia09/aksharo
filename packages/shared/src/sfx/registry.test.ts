import assert from "node:assert/strict";
import test from "node:test";

import {
  SFX_CALIBRATED_GAIN_DB,
  SFX_DEFAULT_REMOTION_VOLUME,
  SFX_LIBRARY,
  SFX_MIN_PACING_THROTTLE_MS,
  getSfxAsset,
  matchSfxForTrigger,
} from "./registry.js";

test("sfx registry includes all 50 curated sound effects", () => {
  assert.equal(SFX_LIBRARY.length, 50);
  const ids = new Set(SFX_LIBRARY.map((s) => s.id));
  assert.equal(ids.size, 50, "all 50 asset ids must be unique");
});

test("all assets have valid categories and calibrated volume", () => {
  const allowedCategories = new Set(["whoosh", "pop", "ding", "cash", "impact"]);
  for (const asset of SFX_LIBRARY) {
    assert.ok(allowedCategories.has(asset.category), `unknown category: ${asset.category}`);
    assert.equal(asset.calibratedGainDb, SFX_CALIBRATED_GAIN_DB);
    assert.equal(asset.defaultVolume, SFX_DEFAULT_REMOTION_VOLUME);
    assert.ok(asset.durationSec > 0, "duration must be positive");
    assert.ok(asset.fileName.endsWith(".wav"), "file must be .wav");
  }
});

test("pacing throttle SLA enforces at least 2.5 seconds spacing", () => {
  assert.equal(SFX_MIN_PACING_THROTTLE_MS, 2500);
});

test("trigger matching returns category-aligned assets", () => {
  const zoomSfx = matchSfxForTrigger("zoom");
  assert.equal(zoomSfx.category, "whoosh");

  const emojiSfx = matchSfxForTrigger("emoji");
  assert.equal(emojiSfx.category, "pop");

  const moneySfx = matchSfxForTrigger("money");
  assert.equal(moneySfx.category, "cash");

  const hookSfx = matchSfxForTrigger("hook");
  assert.equal(hookSfx.category, "impact");

  const emphasisSfx = matchSfxForTrigger("emphasis");
  assert.equal(emphasisSfx.category, "ding");

  const questionSfx = matchSfxForTrigger("question");
  assert.equal(questionSfx.cueType, "notification");
});

test("getSfxAsset returns expected asset by id", () => {
  const asset = getSfxAsset("whoosh_fast");
  assert.ok(asset);
  assert.equal(asset.id, "whoosh_fast");
  assert.equal(asset.title, "Whoosh Fast");

  const missing = getSfxAsset("non_existent_sfx");
  assert.equal(missing, undefined);
});
