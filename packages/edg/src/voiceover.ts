/**
 * How a voice-over hook becomes part of a clip's document (2026-10-01).
 *
 * A voice-over hook is a short synthetic voice reading the clip's hook line at
 * the start of the clip (`apps/api/src/repurpose/voiceover`). It is not baked
 * into the clip's media: it is an accepted `sfx` pass item on the clip's
 * editing document, so the cloud render and the browser export mix it as they
 * mix any cue, the editor's timeline shows it on the sound row, and a person
 * takes it off by rejecting it like any other proposal.
 *
 * Two things make it unlike a sound effect, both carried on the cue's payload
 * so every renderer reads them from the same place:
 *
 * - **`playThrough`**: a spoken line plays from its start for its whole length
 *   on the finished video, rather than being cut wherever autocut removed a
 *   silence after its start (that would drop syllables);
 * - **`dialogueDuck`**: the clip's own sound is pulled down
 *   {@link VOICEOVER_DIALOGUE_DUCK}`.depthDb` while the voice speaks, ramped,
 *   so the speaker's first words sit under the hook instead of fighting it.
 *
 * The item's `assetId` is the voice-over's own id and its `packId` is
 * {@link VOICEOVER_PACK_ID}: it resolves only among the workspace's voice-overs,
 * never in the licensed catalogue, as a brand kit's track resolves only among
 * the workspace's brand assets.
 */

import type { Pass, SfxPassItem } from "./schemas/pass.js";

/** The `packId` of a voice-over cue: its `assetId` is a `clip_voiceovers` row. */
export const VOICEOVER_PACK_ID = "voiceover";

/** The engine a voice-over pass is filed under (`edg_passes.engine`). */
export const VOICEOVER_ENGINE = "voiceover-hook@1";

/**
 * The clip's own sound under the voice: 14 dB down, ramped over 200 ms. Low
 * enough that the hook is the thing heard, high enough that the room and the
 * speaker's first breath are still there, so the cut into the clip is not a
 * jump from silence.
 */
export const VOICEOVER_DIALOGUE_DUCK = { depthDb: -14, attackMs: 200, releaseMs: 300 } as const;

/** The voice's own edges: a short fade so neither end clicks. */
export const VOICEOVER_FADE_MS = { in: 20, out: 120 } as const;

/** The voice's level against the clip: as synthesised (the vendor normalises it). */
export const VOICEOVER_GAIN_DB = 0;

/**
 * The voice-over pass for one clip shape: one accepted `sfx` item starting at
 * `startMs` (the source-clock time the finished video starts at, so it is the
 * first thing heard even when autocut trimmed the opening) and lasting the
 * voice's own `durationMs`, or `undefined` when either is unusable.
 *
 * `passId`/`itemId` should be the same on every ask for the same voice-over
 * and shape (`stableOverlayId`), so a repeated ask lands the same item.
 */
export function voiceoverPass(input: {
  readonly voiceoverId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly text: string;
  readonly language: string;
  readonly speaker: string;
  readonly passId: string;
  readonly itemId: string;
}): Pass | undefined {
  const startMs = Math.max(0, Math.round(input.startMs));
  const durationMs = Math.round(input.durationMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return undefined;
  }
  const licenceSnapshot = {
    source: "voiceover",
    provider: "sarvam",
    voice: input.speaker,
    language: input.language,
  };
  const item: SfxPassItem = {
    itemId: input.itemId,
    passId: input.passId,
    kind: "sfx",
    startMs,
    endMs: startMs + durationMs,
    state: "accepted",
    reason: "Voice-over hook",
    licenceSnapshot,
    payload: {
      assetId: input.voiceoverId,
      packId: VOICEOVER_PACK_ID,
      startMs,
      durationMs,
      gainDb: VOICEOVER_GAIN_DB,
      fadeInMs: VOICEOVER_FADE_MS.in,
      fadeOutMs: VOICEOVER_FADE_MS.out,
      // The voice is never quieted under speech: it IS the speech here.
      duck: null,
      licenceSnapshot,
      cueReason: `Voice-over hook: ${input.text}`.slice(0, 500),
      playThrough: true,
      dialogueDuck: { ...VOICEOVER_DIALOGUE_DUCK },
    },
  };
  return {
    passId: input.passId,
    type: "sfx",
    engine: VOICEOVER_ENGINE,
    params: { voiceoverId: input.voiceoverId, language: input.language, speaker: input.speaker },
    status: "ready",
    items: [item],
  };
}

/** Whether `item` is a voice-over hook (not a catalogue sound effect). */
export function isVoiceoverItem(item: {
  readonly kind: string;
  readonly payload?: unknown;
}): boolean {
  return (
    item.kind === "sfx" &&
    typeof item.payload === "object" &&
    item.payload !== null &&
    (item.payload as { packId?: unknown }).packId === VOICEOVER_PACK_ID
  );
}
