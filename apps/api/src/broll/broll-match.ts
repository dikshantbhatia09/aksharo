/**
 * Which picture of a workspace's B-roll library shows a moment (2026-10-05),
 * and which moments a library picture was made for.
 *
 * A picture is matched on its tags, and on its title's words, against what a
 * moment is about: the search phrase the model wrote for it ("taj mahal at
 * sunrise") and the words the speaker said ("Taj Mahal dekha"). The best match
 * is:
 *
 * 1. a tag that is the phrase, or is said word for word (1 and 0.9);
 * 2. a tag that holds the whole phrase ("taj mahal agra" for "taj mahal", 0.8);
 * 3. otherwise the share of the phrase's words (not "the" or "ka") that the
 *    picture's tags and title carry, at half weight.
 *
 * {@link bestPicture} keeps the best match of at least {@link MIN_MATCH}, and
 * prefers one the clip has not used yet, then one shaped like the frame.
 * {@link spokenTags} is the other way round: every tag said word for word in a
 * clip is a moment for that picture, which needs no language model at all.
 *
 * Pure. Tags are stored normalised ({@link normaliseTag}), so the library page
 * shows exactly what is matched on.
 */

import type { BrollProposal, BrollWord } from "@montaj/edg";

/** Below this, a picture does not show the moment: nothing is better than a wrong picture. */
export const MIN_MATCH = 0.6;

/** A picture as matching reads it. */
export interface LibraryPicture {
  readonly id: string;
  readonly tags: readonly string[];
  readonly title: string | null;
  readonly width: number;
  readonly height: number;
  readonly format: "png" | "jpeg" | "webp";
}

/** Words that say nothing about what a picture shows, in English and Hinglish. */
const STOPWORDS: ReadonlySet<string> = new Set(
  `a an the of in on at to for with and or from by into over under near this that these those
   is are was were be my your our their his her its some any very
   ka ki ke ko se me mein par aur ya hai hain tha thi the ek yeh woh wo`.split(/\s+/u),
);

/**
 * A tag as it is stored and compared: NFKC, lower case, only letters, marks,
 * digits and single spaces between words (so "Taj-Mahal!" is "taj mahal").
 */
export function normaliseTag(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** A picture's tags: normalised, the empty and the repeated left out, at most `max`. */
export function normaliseTags(values: readonly string[], max: number, maxLength: number): string[] {
  const kept: string[] = [];
  for (const value of values) {
    const tag = normaliseTag(value).slice(0, maxLength).trim();
    if (tag === "" || kept.includes(tag)) continue;
    kept.push(tag);
    if (kept.length >= max) break;
  }
  return kept;
}

function tokens(text: string): string[] {
  const normal = normaliseTag(text);
  return normal === "" ? [] : normal.split(" ");
}

/** Whether `needle`'s words appear, in order and together, in `haystack`'s. */
function containsWords(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack.at(start + offset) === word)) return true;
  }
  return false;
}

/** How well `picture` shows a moment about `phrase`, whose words were `spoken`: 0 to 1. */
export function pictureScore(picture: LibraryPicture, phrase: string, spoken: string): number {
  const phraseWords = tokens(phrase);
  const spokenWords = tokens(spoken);
  let best = 0;
  for (const tag of picture.tags) {
    const tagWords = tokens(tag);
    if (tagWords.length === 0) continue;
    if (tagWords.join(" ") === phraseWords.join(" ")) return 1;
    if (containsWords(spokenWords, tagWords) || containsWords(phraseWords, tagWords)) {
      best = Math.max(best, 0.9);
    } else if (containsWords(tagWords, phraseWords)) {
      best = Math.max(best, 0.8);
    }
  }
  const meaningful = phraseWords.filter((word) => !STOPWORDS.has(word));
  if (meaningful.length > 0) {
    const described = new Set([
      ...picture.tags.flatMap((tag) => tokens(tag)),
      ...tokens(picture.title ?? ""),
    ]);
    const shared = meaningful.filter((word) => described.has(word)).length;
    best = Math.max(best, (shared / meaningful.length) * 0.5 + (shared > 0 ? 0.25 : 0));
  }
  return Math.min(1, best);
}

/**
 * The picture that best shows a moment, or `undefined` when none reaches
 * {@link MIN_MATCH}. Among equals: one the clip has not used (`used`), then one
 * shaped like the frame, then the earliest in `pictures` (the newest, as the
 * library lists them).
 */
export function bestPicture(
  pictures: readonly LibraryPicture[],
  moment: { readonly phrase: string; readonly spoken: string },
  options: {
    readonly used?: ReadonlySet<string>;
    readonly canvas?: { readonly width: number; readonly height: number };
    readonly minScore?: number;
  } = {},
): LibraryPicture | undefined {
  const minScore = options.minScore ?? MIN_MATCH;
  const frame =
    options.canvas === undefined || options.canvas.height <= 0
      ? undefined
      : options.canvas.width / options.canvas.height;
  const shapeFit = (picture: LibraryPicture): number => {
    if (frame === undefined || picture.height <= 0) return 0;
    const shape = picture.width / picture.height;
    return Math.min(shape, frame) / Math.max(shape, frame);
  };
  let chosen: { picture: LibraryPicture; rank: readonly number[] } | undefined;
  for (const [index, picture] of pictures.entries()) {
    const score = pictureScore(picture, moment.phrase, moment.spoken);
    if (score < minScore) continue;
    const rank = [score, options.used?.has(picture.id) === true ? 0 : 1, shapeFit(picture), -index];
    if (chosen === undefined || outranks(rank, chosen.rank)) chosen = { picture, rank };
  }
  return chosen?.picture;
}

function outranks(a: readonly number[], b: readonly number[]): boolean {
  for (const [index, value] of a.entries()) {
    const other = b.at(index) ?? 0;
    if (value !== other) return value > other;
  }
  return false;
}

/** A moment a library picture was made for: its tag, said word for word. */
export interface SpokenTag extends BrollProposal {
  readonly phrase: string;
  readonly pictureId: string;
}

/**
 * Every place a picture's tag is said word for word in `words` (the clip's
 * words that play, with their text), as proposals for that picture: the
 * deterministic half of Autopilot's B-roll, which needs no language model. A
 * tag of one short word ("a", "tv") is too easy to hear by chance and is left
 * out; a longer tag is kept first.
 */
export function spokenTags(
  words: readonly (BrollWord & { readonly t: string })[],
  pictures: readonly LibraryPicture[],
): SpokenTag[] {
  const said = words.map((word) => normaliseTag(word.t));
  const found: SpokenTag[] = [];
  for (const picture of pictures) {
    for (const tag of picture.tags) {
      const tagWords = tokens(tag);
      if (tagWords.length === 0) continue;
      if (tagWords.length === 1 && ((tagWords[0] ?? "").length < 4 || STOPWORDS.has(tag))) continue;
      for (let start = 0; start + tagWords.length <= said.length; start += 1) {
        const matches = tagWords.every((word, offset) => said.at(start + offset) === word);
        if (!matches) continue;
        const first = words.at(start);
        const last = words.at(start + tagWords.length - 1);
        if (first === undefined || last === undefined) continue;
        found.push({
          startWordId: first.wid,
          endWordId: last.wid,
          // A tag said is a strong sign; a longer tag a stronger one.
          score: 6 + Math.min(3, tagWords.length - 1),
          phrase: tag,
          pictureId: picture.id,
        });
      }
    }
  }
  return found;
}
