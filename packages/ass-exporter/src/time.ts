/** ASS timestamps: `H:MM:SS.CC`, centiseconds, floor rather than round (never show text early). */
export function toAssTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const centis = Math.floor(clamped / 10);
  const cs = centis % 100;
  const totalSeconds = Math.floor(centis / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h)}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(
    cs,
  ).padStart(2, "0")}`;
}

/** Milliseconds → ASS karaoke centiseconds (`\k`/`\kf` argument), floored, never negative. */
export function toKaraokeCentis(ms: number): number {
  return Math.max(0, Math.floor(ms / 10));
}
