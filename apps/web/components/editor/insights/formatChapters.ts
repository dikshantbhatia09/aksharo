/**
 * Pure formatting helpers for the Insights tab (B11). Kept dependency-free
 * (no React) so they are trivially unit-tested.
 */
export interface ChapterLike {
  readonly startMs: number;
  readonly title: string;
}

/** `MM:SS` for < 1 h, `H:MM:SS` past it — the format YouTube's own chapter list uses. */
export function formatChapterTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Chapters as a YouTube description block: one `timestamp title` line per
 * chapter, first at `0:00` (YouTube requires the first chapter to start at
 * the very beginning to recognise the list at all).
 */
export function chaptersAsYouTubeDescription(chapters: readonly ChapterLike[]): string {
  return chapters
    .map((chapter, index) => {
      const timestamp = index === 0 ? "0:00" : formatChapterTimestamp(chapter.startMs);
      return `${timestamp} ${chapter.title}`;
    })
    .join("\n");
}
