/**
 * 12 prompted-edit fixtures (D07 §1: "eval fixtures (12 prompts incl.
 * Hinglish)") — free-text instructions paired with the project facts the
 * planner sees, reusing `FIXTURES`' transcripts for grounding.
 */
import { FIXTURES } from "./fixtures.js";

import type { EditPlanInput, EditPlanPlanTier } from "../templates/edit-plan.js";

export interface EditPlanFixture {
  readonly id: string;
  readonly input: EditPlanInput;
}

function inputFor(
  fixtureId: string,
  prompt: string,
  planTier: EditPlanPlanTier,
  existingStyles: readonly string[] = [],
): EditPlanInput {
  const fixture = FIXTURES.find((f) => f.id === fixtureId);
  if (fixture === undefined) throw new Error(`no transcript fixture "${fixtureId}"`);
  const t = fixture.transcript;
  return {
    prompt,
    language: t.language,
    durationMs: t.durationMs,
    existingStyles: [...existingStyles],
    planTier,
    segments: t.segments.map((s) => ({ ...s })),
    ...(t.mediaTitle === undefined ? {} : { mediaTitle: t.mediaTitle }),
  };
}

export const EDIT_PLAN_FIXTURES: readonly EditPlanFixture[] = [
  {
    id: "cut-silences",
    input: inputFor("english", "Cut out the silences and awkward pauses", "creator"),
  },
  {
    id: "cut-and-music",
    input: inputFor(
      "english",
      "Remove the boring parts and add some upbeat background music",
      "studio",
    ),
  },
  {
    id: "vertical-reels",
    input: inputFor("english", "Make this vertical for Instagram Reels", "creator"),
  },
  {
    id: "punch-in-face",
    input: inputFor("english", "Zoom in on my face when I get excited", "creator"),
  },
  {
    id: "sfx-laughs",
    input: inputFor("english", "Add sound effects for the funny moments", "studio"),
  },
  {
    id: "titles-hook",
    input: inputFor("english", "Add on-screen titles for my hook and key stats", "creator"),
  },
  {
    id: "best-quality-pro",
    input: inputFor("english", "Give me the absolute best quality cut, spare no credits", "agency"),
  },
  {
    id: "existing-style",
    input: inputFor("english", "Cut the silences and use my bold-caption style", "creator", [
      "style_bold_caption",
    ]),
  },
  {
    id: "hindi-cut-music",
    input: inputFor("hindi", "चुप्पी हटाओ और थोड़ा संगीत जोड़ो", "creator"),
  },
  {
    id: "tamil-reframe",
    input: inputFor("tamil", "இதை செங்குத்து வீடியோவாக மாற்று", "creator"),
  },
  {
    id: "hinglish-full-edit",
    input: inputFor(
      "hinglish",
      "Silence cut karo, vertical bana do aur thoda background music bhi daal do",
      "studio",
    ),
  },
  {
    id: "starter-budget",
    input: inputFor("english", "Just clean up the silences please", "starter"),
  },
] as const;
