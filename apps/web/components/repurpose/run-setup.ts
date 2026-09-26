/**
 * A run's setup, carried from a failed run back to the start form.
 *
 * "Choose another video" used to open an empty form, so someone whose link
 * failed had to pick their caption look, languages and method all over again —
 * and for a link that only needed fixing (a playlist, a typo) they lost the link
 * too (clips hardening, 2026-09-26). The run view the API returns carries
 * neither the setup nor the link (§17.4: the run row never stores the URL), so
 * the start form remembers both for the run it creates, in this browser, and a
 * failed run hands them back through the new form's query string.
 *
 * `rightsAttested` is never carried: a URL in a query string is not consent.
 */
import {
  EMPTY_START_FORM,
  RECOMMENDED_STYLES,
  type StartFormValue,
} from "@/components/repurpose/SourceStartForm";

export interface RunSetup {
  readonly sourceLanguage?: string;
  readonly outputLanguage: string;
  readonly scriptMode: string;
  readonly styleId: string;
  readonly method: "ai" | "manual";
  readonly requestedCandidates: number;
  /** The link as sent, for a link run only. */
  readonly link?: string;
}

const STORAGE_KEY = "aksharo.repurpose.setups";
/** Enough for anyone's recent runs; the oldest are forgotten first. */
const MAX_REMEMBERED = 20;

const OUTPUT_LANGUAGES = new Set(["same", "en", "hi", "hi-Latn"]);
const SCRIPT_MODES = new Set(["auto", "roman", "native", "bilingual"]);

type Remembered = Record<string, RunSetup & { readonly at: number }>;

function readAll(): Remembered {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Remembered) : {};
  } catch {
    // Private mode, blocked storage or a corrupt entry: nothing remembered.
    return {};
  }
}

export function setupOf(value: StartFormValue): RunSetup {
  const link = value.tab === "link" ? value.url.trim() : "";
  return {
    ...(value.sourceLanguage === undefined ? {} : { sourceLanguage: value.sourceLanguage }),
    outputLanguage: value.outputLanguage,
    scriptMode: value.scriptMode,
    styleId: value.styleId,
    method: value.method,
    requestedCandidates: value.requestedCandidates,
    ...(link === "" ? {} : { link }),
  };
}

export function rememberRunSetup(runId: string, setup: RunSetup): void {
  try {
    const all = readAll();
    // eslint-disable-next-line security/detect-object-injection -- keyed by a run id the API issued; the store is this browser's own
    all[runId] = { ...setup, at: Date.now() };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_REMEMBERED);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Remembering is a convenience; a full or blocked store only costs the pre-fill.
  }
}

export function recallRunSetup(runId: string): RunSetup | undefined {
  // eslint-disable-next-line security/detect-object-injection -- a run id read back from our own store; a miss is undefined
  const entry = readAll()[runId];
  if (entry === undefined) return undefined;
  const { at: _at, ...setup } = entry;
  return setup;
}

/**
 * The link a YouTube run was started from, read back from the run's own
 * display text, for when this browser did not remember it.
 *
 * That is not rare. A run started in another browser or device, in a private
 * window, or before setups were remembered at all (2026-09-26) has no entry
 * here, and "Start again with this video" then opened an empty "Paste a link"
 * form under a button that promised this video. The API never stores the URL
 * (§17.4), but it writes a YouTube run's display as `youtube.com · <video id>`
 * (`youtubeResult` in its `source-url.ts`) and never changes it, and the id is
 * all the canonical link needs. Anything else gives no link: guessing one
 * would be a button that cannot keep its promise.
 */
export function linkFromSourceDisplay(display: string | null | undefined): string | undefined {
  if (display === null || display === undefined) return undefined;
  const id = /^youtube\.com · ([A-Za-z0-9_-]{11})$/.exec(display.trim())?.[1];
  return id === undefined ? undefined : `https://www.youtube.com/watch?v=${id}`;
}

/**
 * `/repurpose/new`, pre-filled with a setup and, when the link itself is worth
 * keeping (it needs fixing, or the same video is wanted afresh), the link.
 *
 * The link carried is the setup's own (as the person pasted it), else `link`
 * (`linkFromSourceDisplay`), so a run this browser never saw still keeps it.
 *
 * `upload` opens the form on its upload tab: a failed upload run's way out is
 * most likely another file, and landing on "Paste a link" made the button's
 * own label untrue. That and the link hold even with no setup remembered in
 * this browser, so they are the two things carried without one.
 */
export function newRunHref(
  setup: RunSetup | undefined,
  options: { readonly keepLink: boolean; readonly upload?: boolean; readonly link?: string },
): string {
  const params = new URLSearchParams();
  if (options.upload === true) params.set("source", "upload");
  const link = setup?.link ?? options.link;
  if (options.keepLink && link !== undefined) params.set("url", link);
  if (setup === undefined) {
    const query = params.toString();
    return query === "" ? "/repurpose/new" : `/repurpose/new?${query}`;
  }
  if (setup.sourceLanguage !== undefined) params.set("lang", setup.sourceLanguage);
  params.set("out", setup.outputLanguage);
  params.set("script", setup.scriptMode);
  params.set("style", setup.styleId);
  params.set("method", setup.method);
  if (setup.method === "ai") params.set("n", String(setup.requestedCandidates));
  return `/repurpose/new?${params.toString()}`;
}

/**
 * `hi`, `en-IN`, `hi-Latn`: a language, then up to three short subtags. Checked
 * part by part — one pattern for it repeats a group, which backtracks badly.
 */
function isLanguageTag(value: string): boolean {
  const [language, ...subtags] = value.split("-");
  return (
    language !== undefined &&
    /^[A-Za-z]{2,3}$/.test(language) &&
    subtags.length <= 3 &&
    subtags.every((subtag) => /^[A-Za-z0-9]{2,8}$/.test(subtag))
  );
}

/**
 * The first form state for `/repurpose/new`, from its query string.
 *
 * Every value is whitelisted or clamped: this is a URL anyone can craft. A
 * style is kept only if the form offers it, so the chip shown as selected is
 * always the one that will be sent.
 */
export function startFormFromParams(
  params: Pick<URLSearchParams, "get">,
  fallbackLanguage: string | undefined,
): StartFormValue {
  const out = params.get("out");
  const script = params.get("script");
  const style = params.get("style");
  const method = params.get("method") === "manual" ? "manual" : "ai";
  const n = Number(params.get("n"));
  const lang = params.get("lang");
  const url = params.get("url") ?? "";
  return {
    ...EMPTY_START_FORM,
    // A link that came with the URL is what the form is about, whatever else
    // it says; otherwise `source=upload` (a failed upload run) opens that tab.
    tab: url === "" && params.get("source") === "upload" ? "upload" : "link",
    url,
    sourceLanguage: lang !== null && isLanguageTag(lang) ? lang : fallbackLanguage,
    outputLanguage:
      out !== null && OUTPUT_LANGUAGES.has(out) ? out : EMPTY_START_FORM.outputLanguage,
    scriptMode: script !== null && SCRIPT_MODES.has(script) ? script : EMPTY_START_FORM.scriptMode,
    styleId: RECOMMENDED_STYLES.some((entry) => entry.id === style)
      ? (style as string)
      : EMPTY_START_FORM.styleId,
    method,
    requestedCandidates:
      method === "manual"
        ? 0
        : Number.isInteger(n) && n >= 1 && n <= 20
          ? n
          : EMPTY_START_FORM.requestedCandidates,
  };
}
