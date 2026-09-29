import { rulesFor, type SupportedProvider } from "./platforms.js";

/**
 * The words a clip goes out with, per platform (2026-09-29).
 *
 * Source, in order: the clip's own per-platform copy (`repurpose_clips.copy`,
 * `ClipCopySchema`, written by the language model or edited by a person), then
 * its general copy, then its title. The copy may be `{}` - it is filled by a
 * separate step that may not have run - so every field is read on its own and
 * a missing one is simply left out, never invented. No hashtag is made up
 * either: a clip without any goes out without any.
 *
 * A run that came from a YouTube link ends every text with "Watch the full
 * episode" and the link, which is how a short sends people to the long video.
 * The person edits all of it before posting; this is only the starting point.
 */

export interface PostText {
  /** YouTube's title, or TikTok's optional one; null where the platform has none. */
  readonly title: string | null;
  readonly body: string;
}

export interface ClipWords {
  /** `repurpose_clips.title`: the moment's name. */
  readonly title: string;
  /** `repurpose_clips.copy`, as stored - possibly `{}`. */
  readonly copy: unknown;
  /** The full episode, when the run came from a YouTube link. */
  readonly sourceUrl: string | null;
}

const HASHTAG = /^#[\p{L}\p{N}_]+$/u;
/** YouTube video ids, as `source-url.ts` accepts them. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

interface ReadCopy {
  readonly title: string | null;
  readonly hook: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly cta: string | null;
  readonly hashtags: readonly string[];
  readonly platform: {
    readonly youtube: { readonly title: string | null; readonly description: string | null };
    readonly instagram: string | null;
    readonly tiktok: string | null;
    readonly linkedin: string | null;
    readonly x: string | null;
    readonly facebook: string | null;
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Each field on its own: a copy with only hashtags still gives its hashtags. */
export function readCopy(raw: unknown): ReadCopy {
  const copy = record(raw);
  const platforms = record(copy["platforms"]);
  const youtube = record(platforms["youtube"]);
  const hashtags = Array.isArray(copy["hashtags"])
    ? [
        ...new Set(
          copy["hashtags"].filter(
            (tag): tag is string => typeof tag === "string" && HASHTAG.test(tag),
          ),
        ),
      ]
    : [];
  return {
    title: text(copy["title"]),
    hook: text(copy["hook"]),
    summary: text(copy["summary"]),
    description: text(copy["description"]),
    cta: text(copy["cta"]),
    hashtags,
    platform: {
      youtube: { title: text(youtube["title"]), description: text(youtube["description"]) },
      instagram: text(record(platforms["instagram"])["caption"]),
      tiktok: text(record(platforms["tiktok"])["caption"]),
      linkedin: text(record(platforms["linkedin"])["text"]),
      x: text(record(platforms["x"])["text"]),
      facebook: text(record(platforms["facebook"])["text"]),
    },
  };
}

/** The full episode on YouTube, from a run's `source_fingerprint` (`youtube:{id}`). */
export function fullEpisodeUrl(sourceFingerprint: string | null): string | null {
  if (sourceFingerprint === null || !sourceFingerprint.startsWith("youtube:")) return null;
  const id = sourceFingerprint.slice("youtube:".length);
  // The canonical form `source-url.ts` stores: one host, one parameter, no tracking.
  return YOUTUBE_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

const URL_IN_TEXT = /https?:\/\/\S+/g;

/** Characters twitter-text weighs as one: Latin, Indic and the common punctuation. */
function lightCodePoint(code: number): boolean {
  return (
    code <= 0x10ff ||
    (code >= 0x2000 && code <= 0x200d) ||
    (code >= 0x2010 && code <= 0x201f) ||
    (code >= 0x2032 && code <= 0x2037)
  );
}

/**
 * Length as X counts it (twitter-text v3, which Postiz checks with): every
 * link is 23, Latin and Indic scripts one per character, anything else two.
 */
export function xLength(value: string): number {
  const links = value.match(URL_IN_TEXT) ?? [];
  let length = links.length * 23;
  for (const char of value.replace(URL_IN_TEXT, "")) {
    length += lightCodePoint(char.codePointAt(0) ?? 0) ? 1 : 2;
  }
  return length;
}

/** Length in the platform's own counting. */
export function textLength(provider: SupportedProvider, value: string): number {
  return rulesFor(provider).weightedCount ? xLength(value) : [...value].length;
}

function joinParts(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== "").join("\n\n");
}

/**
 * Cut `value` to fit `max` (in `measure`'s counting), ending it with an
 * ellipsis - at a word break when one is near. A binary search, because the
 * measure is not a plain length (X weighs characters) and a text can be long.
 */
function cut(value: string, max: number, measure: (text: string) => number): string {
  if (max <= 0) return "";
  if (measure(value) <= max) return value;
  const chars = [...value];
  const shortened = (end: number): string => `${chars.slice(0, end).join("").trimEnd()}…`;
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(shortened(middle)) <= max) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return "";
  const prefix = chars.slice(0, low).join("");
  const lastSpace = prefix.lastIndexOf(" ");
  // A word break in the last few characters reads better than half a word.
  const tidy =
    lastSpace > 0 && prefix.length - lastSpace < 25 ? prefix.slice(0, lastSpace) : prefix;
  return `${tidy.trimEnd()}…`;
}

/**
 * Fit a text to the platform: first without its hashtags, then by shortening
 * the words - never by dropping the link to the full episode.
 */
function fit(
  provider: SupportedProvider,
  lead: readonly (string | null)[],
  cta: string | null,
  tags: string | null,
): string {
  const limit = rulesFor(provider).bodyLimit;
  const measure = (value: string): number => textLength(provider, value);
  const full = joinParts([...lead, cta, tags]);
  if (measure(full) <= limit) return full;
  const noTags = joinParts([...lead, cta]);
  if (measure(noTags) <= limit) return noTags;
  const ctaLength = cta === null ? 0 : measure(cta) + 2;
  const words = cut(joinParts(lead), limit - ctaLength, measure);
  return cut(joinParts([words, cta]), limit, measure);
}

function hashtagLine(provider: SupportedProvider, hashtags: readonly string[]): string | null {
  const picked = hashtags.slice(0, rulesFor(provider).hashtags);
  return picked.length === 0 ? null : picked.join(" ");
}

/** A person-edited (or model-written) platform text, with the episode link added if missing. */
function withLink(
  provider: SupportedProvider,
  written: string,
  cta: string | null,
  link: string | null,
): string {
  if (cta === null || link === null || written.includes(link)) {
    return cut(written, rulesFor(provider).bodyLimit, (value) => textLength(provider, value));
  }
  return fit(provider, [written], cta, null);
}

/** The starting text for one platform. */
export function defaultPostText(provider: SupportedProvider, words: ClipWords): PostText {
  const copy = readCopy(words.copy);
  const clipTitle = text(words.title) ?? "New clip";
  const title = copy.title ?? clipTitle;
  const blurb = copy.description ?? copy.summary;
  const cta = words.sourceUrl === null ? copy.cta : `Watch the full episode: ${words.sourceUrl}`;
  const tags = hashtagLine(provider, copy.hashtags);
  const rules = rulesFor(provider);
  const titleField = (value: string): string =>
    cut(value, rules.titleLimit ?? 0, (t) => [...t].length);

  switch (provider) {
    case "youtube": {
      const ytTitle = titleField(copy.platform.youtube.title ?? title);
      const written = copy.platform.youtube.description;
      return {
        // YouTube refuses a title under two characters.
        title: [...ytTitle].length >= 2 ? ytTitle : titleField(`${ytTitle} clip`),
        body:
          written === null
            ? fit(provider, [blurb], cta, tags)
            : withLink(provider, written, cta, words.sourceUrl),
      };
    }
    case "tiktok": {
      const written = copy.platform.tiktok;
      return {
        title: titleField(title),
        body:
          written === null
            ? fit(provider, [copy.hook ?? title], cta, tags)
            : withLink(provider, written, cta, words.sourceUrl),
      };
    }
    case "instagram": {
      const written = copy.platform.instagram;
      return {
        title: null,
        body:
          written === null
            ? fit(provider, [copy.hook ?? title, blurb], cta, tags)
            : withLink(provider, written, cta, words.sourceUrl),
      };
    }
    case "facebook":
    case "linkedin": {
      const written = provider === "facebook" ? copy.platform.facebook : copy.platform.linkedin;
      return {
        title: null,
        body:
          written === null
            ? fit(provider, [title, blurb], cta, tags)
            : withLink(provider, written, cta, words.sourceUrl),
      };
    }
    case "x": {
      const written = copy.platform.x;
      return {
        title: null,
        body:
          written === null
            ? fit(provider, [copy.hook ?? title], cta, tags)
            : withLink(provider, written, cta, words.sourceUrl),
      };
    }
    case "threads":
      return {
        title: null,
        body: fit(provider, [copy.hook ?? title], cta, tags),
      };
  }
}

/** The hashtags in a text, for YouTube's tags. */
export function hashtagsIn(value: string): string[] {
  return [...new Set(value.match(/#[\p{L}\p{N}_]+/gu) ?? [])];
}

/**
 * Why a person's text cannot go out on `provider`, as one sentence, or null
 * when it can. Checked on the way in, so a refusal is said in the dialog
 * rather than discovered minutes later as a failed post.
 */
export function problemWithText(provider: SupportedProvider, post: PostText): string | null {
  const rules = rulesFor(provider);
  const body = post.body.trim();
  if (body === "") return `Write something for ${rules.label}.`;
  if (textLength(provider, body) > rules.bodyLimit) {
    return `The ${rules.label} text is too long: ${rules.bodyLimit.toLocaleString("en-IN")} characters at most.`;
  }
  if (rules.titleLimit !== null) {
    const title = (post.title ?? "").trim();
    if (rules.titleRequired && [...title].length < 2) {
      return `Give the ${rules.label} video a title.`;
    }
    if ([...title].length > rules.titleLimit) {
      return `The ${rules.label} title is too long: ${String(rules.titleLimit)} characters at most.`;
    }
  }
  return null;
}
