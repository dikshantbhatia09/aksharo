import type { VideoShape } from "@montaj/repurpose-contracts";

import type { EpisodePack } from "../episode-pack.schema.js";
import type { GuestClipPlan, ShapeFiles } from "../guest/guest-files.js";

/**
 * What "Download all" puts in the ZIP (2026-10-01), decided before anything is
 * read: pure, so the layout is tested on its own and the service only reads
 * rows, sizes the objects and streams them.
 *
 *     <Video title>/
 *       Episode text.txt                          chapters, descriptions, posts
 *       01 <Clip title>/
 *         <Clip title> 9x16.mp4 ... 16x9.mp4      every shape, captions burned in
 *         Words to post.txt                       title, caption, hashtags, per platform
 *         Images/<Clip title> <image>.jpg
 *         Dubbed <Language>/<Clip title> 9x16 <Language>.mp4 ...
 *         Without captions/<Clip title> 9x16 no captions.mp4 ...   (when asked for)
 *       Compilations/<Title> 9x16.mp4
 *
 * A shape with no captioned video yet but a clean cut has the clean cut in
 * "Without captions" either way, so no shape is missing. Every file is one the
 * team already has (the guest page's choice of files, `planGuestClip`).
 *
 * Names are made safe for Windows, macOS and Linux (no `\/:*?"<>|`, no control
 * characters, no trailing dot or space, no reserved device name), kept short,
 * and made unique case-insensitively.
 */

export type BundleFileKind = "video" | "clean" | "image" | "dub" | "text" | "compilation";

export type BundleSource =
  | { readonly kind: "object"; readonly key: string }
  | { readonly kind: "text"; readonly text: string };

export interface BundleFile {
  readonly path: string;
  readonly kind: BundleFileKind;
  readonly source: BundleSource;
  /**
   * A clean cut that is there only because "without captions" was asked for
   * (its shape has a captioned video). A clean cut standing in for a missing
   * captioned video is not optional.
   */
  readonly optional: boolean;
}

export interface BundleClip {
  readonly plan: GuestClipPlan;
}

export interface BundleCompilation {
  readonly title: string | null;
  readonly shape: VideoShape;
  readonly key: string;
}

export interface BundleInput {
  readonly runTitle: string;
  readonly clips: readonly BundleClip[];
  readonly compilations: readonly BundleCompilation[];
  readonly episode: EpisodePack | null;
  /** Also every shape's clean cut (and each dub's): about doubles the size. */
  readonly includeClean: boolean;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file or folder name every desktop accepts, at most `max` characters. */
export function safeSegment(name: string, max = 60, fallback = "Untitled"): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...cleaned];
  let cut = chars.slice(0, max).join("").trim();
  // A name that had to be shortened ends at a word, not part way through one.
  if (chars.length > max) {
    const space = cut.lastIndexOf(" ");
    if (space >= Math.floor(cut.length / 2)) cut = cut.slice(0, space);
  }
  cut = cut.replace(/[. ]+$/g, "");
  if (cut === "") cut = fallback;
  if (RESERVED.test(cut.split(".")[0] ?? "")) cut = `${cut}_`;
  return cut;
}

function shapeTag(shape: VideoShape): string {
  return shape.replace(":", "x");
}

function pad(index: number, total: number): string {
  return String(index + 1).padStart(Math.max(2, String(total).length), "0");
}

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  any: "Any platform",
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  x: "X",
};

/** The words to post a clip with, as a text file people open in Notepad. */
export function wordsToPostText(plan: GuestClipPlan): string | null {
  if (plan.posts.length === 0 && plan.hashtags.length === 0) return null;
  const lines: string[] = [plan.title, ""];
  for (const post of plan.posts) {
    lines.push(`== ${PLATFORM_NAMES[post.platform] ?? post.platform} ==`);
    if (post.title !== null && post.title.trim() !== "") lines.push(`Title: ${post.title.trim()}`);
    if (post.text.trim() !== "") lines.push(post.text.trim());
    lines.push("");
  }
  if (plan.hashtags.length > 0) {
    lines.push("== Hashtags ==", plan.hashtags.join(" "), "");
  }
  return lines.join("\r\n");
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The episode text pack (chapters, descriptions, posts) as one text file. */
export function episodeText(runTitle: string, pack: EpisodePack): string | null {
  const sections: [string, string][] = [];
  const chapters = pack.chapters
    .map((chapter) => `${clock(chapter.startMs)} ${chapter.title.trim()}`)
    .filter((line) => line.trim() !== "");
  if (chapters.length > 0) sections.push(["Chapters", chapters.join("\r\n")]);
  if (pack.youtubeDescription.trim() !== "") {
    sections.push(["YouTube description", pack.youtubeDescription.trim()]);
  }
  if (pack.showNotes.trim() !== "") sections.push(["Show notes", pack.showNotes.trim()]);
  if (pack.linkedinPost.trim() !== "") sections.push(["LinkedIn post", pack.linkedinPost.trim()]);
  const thread = pack.xThread.map((post) => post.trim()).filter((post) => post !== "");
  if (thread.length > 0) {
    sections.push([
      "X thread",
      thread.map((post, index) => `${String(index + 1)}/${String(thread.length)} ${post}`).join("\r\n\r\n"),
    ]);
  }
  if (pack.newsletter.trim() !== "") sections.push(["Newsletter", pack.newsletter.trim()]);
  if (sections.length === 0) return null;
  const body = sections.map(([heading, text]) => `== ${heading} ==\r\n${text}`).join("\r\n\r\n");
  return `${runTitle}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

/** Every file of the ZIP, in the order it is written, with unique paths. */
export function bundleFilesOf(input: BundleInput): BundleFile[] {
  const root = safeSegment(input.runTitle, 35, "Clips");
  const files: BundleFile[] = [];
  const add = (
    path: string,
    kind: BundleFileKind,
    source: BundleSource,
    optional = false,
  ): void => {
    files.push({ path, kind, source, optional });
  };

  if (input.episode !== null) {
    const text = episodeText(input.runTitle, input.episode);
    if (text !== null) add(`${root}/Episode text.txt`, "text", { kind: "text", text });
  }

  input.clips.forEach(({ plan }, index) => {
    const stem = safeSegment(plan.title, 30);
    const folder = `${root}/${pad(index, input.clips.length)} ${stem}`;
    const shapes = (
      videos: readonly ShapeFiles[],
      dir: string,
      kind: "video" | "dub",
      suffix: string,
    ): void => {
      for (const files of videos) {
        const tag = shapeTag(files.shape);
        if (files.captionedKey !== null) {
          add(`${dir}/${tag}${suffix}.mp4`, kind, {
            kind: "object",
            key: files.captionedKey,
          });
        }
        if (files.cleanKey !== null && (input.includeClean || files.captionedKey === null)) {
          add(
            `${dir}/Without captions/${tag}${suffix} no captions.mp4`,
            "clean",
            { kind: "object", key: files.cleanKey },
            files.captionedKey !== null,
          );
        }
      }
    };

    shapes(plan.videos, folder, "video", "");
    const words = wordsToPostText(plan);
    if (words !== null) add(`${folder}/Words to post.txt`, "text", { kind: "text", text: words });
    for (const image of plan.images) {
      for (const entry of image.keys) {
        add(`${folder}/Images/${safeSegment(entry.name, 25, image.id)}.jpg`, "image", {
          kind: "object",
          key: entry.key,
        });
      }
    }
    for (const dub of plan.dubs) {
      const language = safeSegment(dub.name, 20, dub.language);
      shapes(dub.videos, `${folder}/Dubbed ${language}`, "dub", ` ${language}`);
    }
  });

  for (const compilation of input.compilations) {
    const title = safeSegment(compilation.title ?? "Compilation", 30);
    add(`${root}/Compilations/${title} ${shapeTag(compilation.shape)}.mp4`, "compilation", {
      kind: "object",
      key: compilation.key,
    });
  }

  return unique(files);
}

/** Paths made unique the way Windows compares them: " (2)" before the extension. */
function unique(files: readonly BundleFile[]): BundleFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    let path = file.path;
    let attempt = 1;
    while (seen.has(path.toLowerCase())) {
      attempt += 1;
      const dot = file.path.lastIndexOf(".");
      const slash = file.path.lastIndexOf("/");
      path =
        dot > slash
          ? `${file.path.slice(0, dot)} (${String(attempt)})${file.path.slice(dot)}`
          : `${file.path} (${String(attempt)})`;
    }
    seen.add(path.toLowerCase());
    return path === file.path ? file : { ...file, path };
  });
}
