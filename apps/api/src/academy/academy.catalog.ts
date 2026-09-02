/**
 * Authoritative track/step catalogue the API validates progress writes and
 * computes rewards against.
 *
 * The presentation copy for these same four tracks lives as MDX in
 * `apps/web/content/academy/*.mdx` (id, title, steps, `completionEvent`,
 * `creditReward` match this file exactly). The two are kept in sync by hand
 * rather than the API reading `apps/web/content` at runtime — a different
 * app, a different deploy, and a static catalogue the API can validate
 * against without a filesystem dependency on a sibling app's build output.
 * `academy.catalog.test.ts` is the sync check: it re-derives this shape from
 * the web content module at test time and fails if the two diverge.
 */
export interface AcademyCatalogStep {
  readonly id: string;
  readonly completionEvent?: "export.completed";
}

export interface AcademyCatalogTrack {
  readonly id: string;
  readonly title: string;
  /** Credits, whole units (not tenths) — capped 25/track per the brief. */
  readonly creditReward: number;
  readonly steps: readonly AcademyCatalogStep[];
}

export const ACADEMY_LIFETIME_CAP_TENTHS = 1_000; // 100 credits, brief §2

export const ACADEMY_TRACKS: readonly AcademyCatalogTrack[] = [
  {
    id: "hinglish-reel",
    title: "Your first Hinglish reel in 10 minutes",
    creditReward: 15,
    steps: [
      { id: "upload-clip" },
      { id: "review-transcript" },
      { id: "pick-style" },
      { id: "export", completionEvent: "export.completed" },
    ],
  },
  {
    id: "podcast-clips",
    title: "Podcast clips with chapters",
    creditReward: 20,
    steps: [
      { id: "upload-episode" },
      { id: "diarise-speakers" },
      { id: "mark-chapters" },
      { id: "export-clips", completionEvent: "export.completed" },
    ],
  },
  {
    id: "captions-in-premiere",
    title: "Captions inside Premiere",
    creditReward: 15,
    steps: [
      { id: "install-plugin" },
      { id: "link-project" },
      { id: "adjust-captions" },
      { id: "sync-back" },
    ],
  },
  {
    id: "agency-workflow",
    title: "Agency workflow",
    creditReward: 25,
    steps: [
      { id: "invite-team" },
      { id: "tag-clients" },
      { id: "apply-brand-kit" },
      { id: "export-report", completionEvent: "export.completed" },
    ],
  },
];

export function getCatalogTrack(trackId: string): AcademyCatalogTrack | undefined {
  return ACADEMY_TRACKS.find((track) => track.id === trackId);
}

/** Tracks whose given step id is `completionEvent: "export.completed"`. */
export function tracksCompletedByExport(): readonly { track: AcademyCatalogTrack; stepId: string }[] {
  const matches: { track: AcademyCatalogTrack; stepId: string }[] = [];
  for (const track of ACADEMY_TRACKS) {
    for (const step of track.steps) {
      if (step.completionEvent === "export.completed") matches.push({ track, stepId: step.id });
    }
  }
  return matches;
}
