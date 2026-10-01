import { describe, expect, it } from "vitest";

import { stableOverlayId } from "./brand.js";
import { PassSchema } from "./schemas/pass.js";
import {
  VOICEOVER_DIALOGUE_DUCK,
  VOICEOVER_PACK_ID,
  isVoiceoverItem,
  voiceoverPass,
} from "./voiceover.js";

const VOICEOVER = "01JCDVC0000000000000000000";

function pass(overrides: Partial<Parameters<typeof voiceoverPass>[0]> = {}) {
  return voiceoverPass({
    voiceoverId: VOICEOVER,
    startMs: 1_240.4,
    durationMs: 2_810.2,
    text: "Nobody tells you this",
    language: "en-IN",
    speaker: "anushka",
    passId: stableOverlayId("variant:voiceover-pass"),
    itemId: stableOverlayId("variant:voiceover"),
    ...overrides,
  });
}

describe("voiceoverPass (2026-10-01)", () => {
  it("is one accepted sfx cue the document takes, from where the video starts", () => {
    const built = pass();
    expect(built).toBeDefined();
    const parsed = PassSchema.parse(built);
    expect(parsed.type).toBe("sfx");
    const [item] = parsed.items;
    expect(item?.kind).toBe("sfx");
    expect(item?.state).toBe("accepted");
    expect(item?.startMs).toBe(1_240);
    expect(item?.endMs).toBe(1_240 + 2_810);
    if (item?.kind !== "sfx") throw new Error("not a cue");
    expect(item.payload.packId).toBe(VOICEOVER_PACK_ID);
    expect(item.payload.assetId).toBe(VOICEOVER);
    expect(item.payload.durationMs).toBe(2_810);
  });

  it("plays through cuts, is never ducked itself, and ducks the clip's own sound", () => {
    const item = pass()?.items[0];
    if (item?.kind !== "sfx") throw new Error("not a cue");
    expect(item.payload.playThrough).toBe(true);
    expect(item.payload.duck).toBeNull();
    expect(item.payload.dialogueDuck).toEqual(VOICEOVER_DIALOGUE_DUCK);
  });

  it("is nothing for a voice with no length", () => {
    expect(pass({ durationMs: 0 })).toBeUndefined();
    expect(pass({ durationMs: Number.NaN })).toBeUndefined();
  });

  it("tells a voice-over from a catalogue sound effect", () => {
    const item = pass()?.items[0];
    expect(item !== undefined && isVoiceoverItem(item)).toBe(true);
    expect(isVoiceoverItem({ kind: "sfx", payload: { packId: "whooshes" } })).toBe(false);
    expect(isVoiceoverItem({ kind: "music", payload: { packId: VOICEOVER_PACK_ID } })).toBe(false);
  });

  it("an older document's cue without the new fields still parses", () => {
    const item = pass()?.items[0];
    if (item?.kind !== "sfx") throw new Error("not a cue");
    const { playThrough: _p, dialogueDuck: _d, ...older } = item.payload;
    void _p;
    void _d;
    expect(PassSchema.parse({ ...pass(), items: [{ ...item, payload: older }] })).toBeDefined();
  });
});
