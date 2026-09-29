"use client";

/**
 * The words to post one clip with (2026-09-29), under its card on the run page:
 * its title, the on-screen hook, the description, the hashtags, and the text
 * each platform wants, every one with its own Copy button.
 *
 * Written by the language model in the speaker's language and script (Hinglish
 * stays in Roman letters), or, when the model could not, from the clip's own
 * words; the summary line says which. Collapsed by default, like "All formats":
 * forty clips with a dozen texts each would bury the videos.
 */
import * as React from "react";

import type { RepurposeClipCopy } from "@montaj/api-client";

import { CopyTextButton } from "@/components/repurpose/copy-text";

export const CLIP_COPY_COPY = Object.freeze({
  summary: "Words to post",
  byModel: "Written by AI from what was said",
  byRule: "Taken from what was said",
  byPerson: "Edited by you",
  title: "Title",
  hook: "On-screen hook",
  description: "Description",
  hashtags: "Hashtags",
  callToAction: "Call to action",
  platforms: "For each platform",
  youtubeTitle: "YouTube title",
  youtubeDescription: "YouTube description",
  instagram: "Instagram caption",
  tiktok: "TikTok caption",
  linkedin: "LinkedIn post",
  x: "X post",
  facebook: "Facebook post",
});

function sourceNote(source: RepurposeClipCopy["source"]): string {
  if (source === "person") return CLIP_COPY_COPY.byPerson;
  if (source === "heuristic") return CLIP_COPY_COPY.byRule;
  return CLIP_COPY_COPY.byModel;
}

interface Field {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** Shown with its length against a limit, e.g. X's 280 characters. */
  readonly limit?: number;
}

/** The copy's fields that have something in them, in the order a person posts. */
export function copyFields(copy: RepurposeClipCopy): {
  readonly main: readonly Field[];
  readonly platforms: readonly Field[];
} {
  const platforms = copy.platforms ?? {};
  const main: Field[] = [
    { id: "title", label: CLIP_COPY_COPY.title, value: copy.title ?? "" },
    { id: "hook", label: CLIP_COPY_COPY.hook, value: copy.hook },
    {
      id: "description",
      label: CLIP_COPY_COPY.description,
      value: copy.description ?? copy.summary,
    },
    { id: "hashtags", label: CLIP_COPY_COPY.hashtags, value: copy.hashtags.join(" ") },
    { id: "cta", label: CLIP_COPY_COPY.callToAction, value: copy.cta },
  ];
  const perPlatform: Field[] = [
    {
      id: "youtube-title",
      label: CLIP_COPY_COPY.youtubeTitle,
      value: platforms.youtube?.title ?? "",
      limit: 100,
    },
    {
      id: "youtube-description",
      label: CLIP_COPY_COPY.youtubeDescription,
      value: platforms.youtube?.description ?? "",
    },
    { id: "instagram", label: CLIP_COPY_COPY.instagram, value: platforms.instagram?.caption ?? "" },
    { id: "tiktok", label: CLIP_COPY_COPY.tiktok, value: platforms.tiktok?.caption ?? "" },
    { id: "linkedin", label: CLIP_COPY_COPY.linkedin, value: platforms.linkedin?.text ?? "" },
    { id: "x", label: CLIP_COPY_COPY.x, value: platforms.x?.text ?? "", limit: 280 },
    { id: "facebook", label: CLIP_COPY_COPY.facebook, value: platforms.facebook?.text ?? "" },
  ];
  return {
    main: main.filter((field) => field.value.trim() !== ""),
    platforms: perPlatform.filter((field) => field.value.trim() !== ""),
  };
}

function CopyField({
  candidateId,
  title,
  field,
}: {
  readonly candidateId: string;
  readonly title: string;
  readonly field: Field;
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1" data-testid={`clip-copy-field-${candidateId}-${field.id}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-2">
          {field.label}
          {field.limit === undefined ? null : (
            <span className="ml-1.5 font-mono font-normal normal-case tracking-normal">
              {String(field.value.length)}/{String(field.limit)}
            </span>
          )}
        </span>
        <CopyTextButton
          text={field.value}
          label={`${field.label.toLowerCase()}: ${title}`}
          testId={`copy-${candidateId}-${field.id}`}
        />
      </div>
      <p className="m-0 whitespace-pre-line break-words text-sm text-fg-1">{field.value}</p>
    </li>
  );
}

export interface ClipCopyPanelProps {
  readonly candidateId: string;
  /** The clip's title as its card shows it, for the Copy buttons' names. */
  readonly title: string;
  readonly copy: RepurposeClipCopy;
}

export function ClipCopyPanel({
  candidateId,
  title,
  copy,
}: ClipCopyPanelProps): React.JSX.Element | null {
  const { main, platforms } = copyFields(copy);
  if (main.length === 0 && platforms.length === 0) return null;

  return (
    <details
      className="rounded-sm border border-border bg-surface"
      data-testid={`clip-copy-${candidateId}`}
      data-source={copy.source ?? "model"}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm text-fg-0">
        {CLIP_COPY_COPY.summary}{" "}
        <span className="text-xs text-fg-2">{sourceNote(copy.source)}</span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {main.map((field) => (
            <CopyField key={field.id} candidateId={candidateId} title={title} field={field} />
          ))}
        </ul>
        {platforms.length === 0 ? null : (
          <section aria-label={`${CLIP_COPY_COPY.platforms}: ${title}`}>
            <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
              {CLIP_COPY_COPY.platforms}
            </h4>
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {platforms.map((field) => (
                <CopyField key={field.id} candidateId={candidateId} title={title} field={field} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  );
}
