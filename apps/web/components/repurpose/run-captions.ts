/**
 * Captions the person already has for the video (2026-10-01, OpusClip's
 * "upload SRT"): an SRT or WebVTT file picked on the start form, or a link to
 * one. The run aligns those captions to the audio instead of transcribing it,
 * so finding its moments costs no credits (`repurpose/run-captions.ts` on the
 * API side).
 *
 * Offered for one video only - a single link or a single file - because a
 * caption file is written for one video. Checked here as a courtesy (format by
 * its name, the 2 MB cap the editor's subtitle import has, a link that is a web
 * address); the API reads, parses and checks it again before the run exists.
 */

import type { CreateRepurposeRunRequest } from "@montaj/api-client";

/** The editor's subtitle import cap (`IMPORT_MAX_BYTES`), which the run's captions share. */
export const CAPTIONS_MAX_BYTES = 2 * 1024 * 1024;

/** What the file picker offers: the two formats that carry their own timings. */
export const CAPTIONS_ACCEPT = ".srt,.vtt,application/x-subrip,text/vtt";

export type CaptionsKind = "srt" | "vtt";

/** `.srt` or `.vtt` at the end of a file name or a link's path; `undefined` otherwise. */
export function captionsKindOf(name: string): CaptionsKind | undefined {
  const path = (name.split("?")[0] ?? "").split("#")[0] ?? "";
  const match = /\.(srt|vtt)$/i.exec(path.trim());
  return match === null ? undefined : (match[1]?.toLowerCase() as CaptionsKind);
}

/** Why a picked caption file cannot be used, or `null` when it can. */
export function captionsFileProblem(file: Pick<File, "name" | "size">): string | null {
  if (captionsKindOf(file.name) === undefined) {
    return "Choose an SRT or VTT caption file.";
  }
  if (file.size === 0) return "That caption file is empty.";
  if (file.size > CAPTIONS_MAX_BYTES) {
    return "That caption file is larger than 2 MB. Choose a smaller one.";
  }
  return null;
}

/** Why a caption link cannot be used, or `null` when it can (an empty one is no link). */
export function captionsLinkProblem(link: string): string | null {
  const trimmed = link.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Paste the full link to the caption file, starting with https://.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Paste the full link to the caption file, starting with https://.";
  }
  if (captionsKindOf(url.pathname) === undefined) {
    return "Link to an SRT or VTT file: the link should end in .srt or .vtt.";
  }
  return null;
}

/** The parts of the form the captions depend on. */
export interface CaptionsFormValue {
  readonly tab: "link" | "links" | "upload";
  readonly file: File | null;
  readonly files: readonly File[];
  readonly captionsFile: File | null;
  readonly captionsUrl: string;
}

/** Whether the form starts one video, the only start captions are offered for. */
export function offersCaptions(value: CaptionsFormValue): boolean {
  if (value.tab === "link") return true;
  if (value.tab !== "upload") return false;
  return value.files.length <= 1;
}

/** Whether captions will be sent with the run: offered, and a file or a link given. */
export function givesCaptions(value: CaptionsFormValue): boolean {
  if (!offersCaptions(value)) return false;
  return value.captionsFile !== null || value.captionsUrl.trim() !== "";
}

/**
 * The run's `setup.captions`, or `undefined` for none: the picked file read as
 * text (it wins over a link), else the link. Reading a 2 MB text file is quick
 * and needs nothing from the network.
 */
export async function captionsToSend(
  value: CaptionsFormValue,
): Promise<CreateRepurposeRunRequest["setup"]["captions"]> {
  if (!offersCaptions(value)) return undefined;
  if (value.captionsFile !== null) {
    const kind = captionsKindOf(value.captionsFile.name);
    if (kind === undefined) return undefined;
    return { from: "file", kind, content: await value.captionsFile.text() };
  }
  const link = value.captionsUrl.trim();
  if (link === "") return undefined;
  const kind = captionsKindOf(link);
  return { from: "url", url: link, ...(kind === undefined ? {} : { kind }) };
}
