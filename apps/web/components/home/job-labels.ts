/**
 * A job's queue name, in words a person reads.
 *
 * `jobs.type` is a queue name from `docs/CONTRACTS.md` §3 — "ai.transcribe",
 * "media.proxy". The repurposing flow's own copy rules (§13.4) forbid the word
 * "queue" and its neighbours ever reaching a person, and a raw type is worse
 * than that: it says nothing about what is happening to their video. This is
 * the whole table, so a type nobody mapped falls back to a sentence rather
 * than to a dotted identifier.
 */
const JOB_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "media.probe": "Reading the file",
  "media.proxy": "Preparing a preview",
  "media.acquire": "Fetching the video",
  "media.clip": "Cutting the clip",
  "ai.vad": "Finding the speech",
  "ai.transcribe": "Transcribing",
  "ai.align": "Aligning words",
  "ai.diarise": "Separating speakers",
  "ai.translate": "Translating",
  "ai.transliterate": "Changing script",
  "ai.clean": "Cleaning the audio",
  "ai.pass": "Reviewing the edit",
  "ai.llm": "Writing",
  "ai.highlights": "Finding moments",
  "render.video": "Rendering",
  "render.subtitle": "Building subtitles",
  "publish.dispatch": "Posting",
  "publish.reconcile": "Checking the post",
  notify: "Sending a notification",
});

export function jobLabel(type: string): string {
  // eslint-disable-next-line security/detect-object-injection -- read-only lookup on a frozen literal map, with a fallback; `type` comes from the API's own closed queue-name set
  return JOB_LABEL[type] ?? "Working";
}

/** "2m 10s", "9m 40s", "48s" — the canvas's monospace ETA column. */
export function formatEta(etaMs: number | null): string {
  if (etaMs === null || !Number.isFinite(etaMs) || etaMs <= 0) return "—";
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
