"use client";

/**
 * A clip in other languages (2026-10-04), on its card: the "Dub" action and
 * the clip's Languages.
 *
 * Each language says where it stands - waiting for a free slot, dubbing (the
 * dubbing service's own percent and step), its videos being made, ready, or
 * what went wrong - and, once ready, plays its captioned 9:16 video and lists
 * every shape with its downloads (with captions and without) and its editor.
 * A dub that failed offers "Try again" (a dub that did not itself fail at the
 * service is picked up where it was, at no extra cost); one still waiting or
 * dubbing offers "Stop dubbing", behind a confirmation, since dubbing those
 * languages again later is paid for again.
 *
 * Nothing shows while dubbing is off for the workspace and the clip has no
 * dubs; a clip that was dubbed before it was switched off keeps its languages.
 */
import { AlertTriangle, Download, Languages, Loader2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  useCancelRepurposeDub,
  useRetryRepurposeDub,
  type RepurposeDub,
  type RepurposeDubFormat,
  type RepurposeDubLanguageView,
  type RepurposeDubList,
} from "@montaj/api-client";
import { Button, ConfirmAction } from "@montaj/ui";

import { DUB_COPY, DUB_SHAPE_NAMES, dubFailureCopy } from "@/components/repurpose/dubbing/copy";
import { DubDialog } from "@/components/repurpose/dubbing/DubDialog";
import { describeRefusal } from "@/components/repurpose/refusal";
import { useStableUrl } from "@/components/repurpose/use-stable-url";

export interface ClipDubsProps {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  readonly list: RepurposeDubList;
  /**
   * Whether a new dub may be asked for: not once the run is stopped, nor
   * while the clip is being cut again. Its languages show either way.
   */
  readonly offerDub?: boolean;
}

export function ClipDubs({
  runId,
  clipId,
  title,
  list,
  offerDub = true,
}: ClipDubsProps): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const offer = list.clips.find((entry) => entry.clipId === clipId);
  const dubs = list.dubs.filter((dub) => dub.clipId === clipId);
  const available =
    offer === undefined || offer.sourceLanguage === null
      ? []
      : list.languages.filter(
          (language) =>
            language.code !== offer.sourceLanguage?.code && !offer.taken.includes(language.code),
        );
  const canDub =
    list.enabled && offerDub && offer !== undefined && offer.ready && available.length > 0;
  if (!canDub && dubs.length === 0) return null;

  const views = dubs.flatMap((dub) => dub.languages.map((language) => ({ dub, language })));
  const ready = views.filter(({ language }) => language.status === "ready").length;

  return (
    <div className="flex flex-col gap-2" data-testid={`clip-dubs-${clipId}`}>
      {canDub ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            aria-label={`${DUB_COPY.button}: ${title}`}
            data-testid={`dub-clip-${clipId}`}
          >
            <Languages strokeWidth={1.75} aria-hidden="true" />
            {DUB_COPY.button}
          </Button>
          <DubDialog
            runId={runId}
            offer={offer}
            languages={list.languages}
            tenthsPerMinute={list.tenthsPerMinute}
            title={title}
            open={open}
            onOpenChange={setOpen}
          />
        </div>
      ) : null}

      {dubs.length === 0 ? null : (
        <details
          className="rounded-sm border border-border bg-surface"
          open
          data-testid={`clip-languages-${clipId}`}
        >
          <summary className="cursor-pointer px-3 py-2 text-sm text-fg-0">
            {DUB_COPY.section}{" "}
            <span className="text-xs text-fg-2">{DUB_COPY.summary(ready, views.length)}</span>
          </summary>
          <ul className="m-0 flex list-none flex-col gap-4 border-t border-border p-3">
            {dubs.map((dub) => (
              <DubRows key={dub.id} runId={runId} title={title} dub={dub} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One dub's languages, and its own Try again or Stop. */
function DubRows({
  runId,
  title,
  dub,
}: {
  readonly runId: string;
  readonly title: string;
  readonly dub: RepurposeDub;
}): React.JSX.Element {
  const retry = useRetryRepurposeDub();
  const cancel = useCancelRepurposeDub();
  const refusal = retry.isError
    ? describeRefusal(retry.error, "dub").text
    : cancel.isError
      ? describeRefusal(cancel.error, "dub").text
      : null;
  return (
    <li className="flex flex-col gap-3" data-testid={`dub-${dub.id}`} data-state={dub.status}>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {dub.languages.map((language) => (
          <LanguageRow key={language.code} dub={dub} language={language} title={title} />
        ))}
      </ul>
      {dub.status === "failed" ? (
        // Why the whole dub failed, once, not on each of its languages.
        <p className="m-0 text-sm text-fg-1" data-testid={`dub-failure-${dub.id}`}>
          {dubFailureCopy(dub.failureCode, dub.failureMessage)}
        </p>
      ) : null}
      {dub.canRetry || dub.canCancel ? (
        <div className="flex flex-wrap items-center gap-2">
          {dub.canRetry ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate({ runId, dubId: dub.id });
              }}
              data-testid={`dub-retry-${dub.id}`}
            >
              {retry.isPending ? DUB_COPY.retrying : DUB_COPY.retry}
            </Button>
          ) : null}
          {dub.canCancel ? (
            <ConfirmAction
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cancel.isPending}
                  data-testid={`dub-stop-${dub.id}`}
                >
                  {DUB_COPY.stop}
                </Button>
              }
              title={DUB_COPY.stopTitle}
              description={DUB_COPY.stopDescription}
              confirmLabel={DUB_COPY.stopConfirm}
              confirmTestId={`dub-stop-confirm-${dub.id}`}
              onConfirm={() => cancel.mutateAsync({ runId, dubId: dub.id }).catch(() => undefined)}
            />
          ) : null}
        </div>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-sm text-rejected" data-testid={`dub-error-${dub.id}`}>
          {refusal}
        </p>
      )}
    </li>
  );
}

function LanguageRow({
  dub,
  language,
  title,
}: {
  readonly dub: RepurposeDub;
  readonly language: RepurposeDubLanguageView;
  readonly title: string;
}): React.JSX.Element {
  const vertical = language.formats.find((format) => format.shape === "9:16");
  const playUrl = useStableUrl(vertical?.captioned?.playUrl ?? undefined);
  const status = statusLine(dub, language);
  const working =
    language.status === "queued" || language.status === "dubbing" || language.status === "making";
  return (
    <li
      className="flex flex-col gap-2"
      data-testid={`dub-language-row-${dub.id}-${language.code}`}
      data-state={language.status}
    >
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium text-fg-0">{language.name}</span>
        <span
          role="status"
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-2"
          data-testid={`dub-language-status-${dub.id}-${language.code}`}
        >
          {working ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
          ) : language.status === "failed" ? (
            <AlertTriangle
              className="size-3.5 text-rejected"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          ) : null}
          {status}
        </span>
      </p>

      {playUrl === undefined ? null : (
        <div className="max-w-[220px] overflow-hidden rounded-sm border border-border bg-ink">
          <video
            src={playUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={DUB_COPY.player(language.name, title)}
            className="aspect-[9/16] w-full object-cover"
            data-testid={`dub-video-${dub.id}-${language.code}`}
          />
        </div>
      )}

      {language.formats.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {language.formats.map((format) => (
            <FormatRow
              key={format.shape}
              dubId={dub.id}
              language={language}
              format={format}
              title={title}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FormatRow({
  dubId,
  language,
  format,
  title,
}: {
  readonly dubId: string;
  readonly language: RepurposeDubLanguageView;
  readonly format: RepurposeDubFormat;
  readonly title: string;
}): React.JSX.Element {
  const name = DUB_SHAPE_NAMES[format.shape];
  const download = format.captioned?.downloadUrl ?? null;
  const note =
    format.status === "failed"
      ? DUB_COPY.shapeFailed
      : format.status === "ready" || (format.status === "stale" && download !== null)
        ? null
        : DUB_COPY.shapePreparing;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2"
      data-testid={`dub-format-${dubId}-${language.code}-${format.shape.replace(":", "x")}`}
      data-state={format.status}
    >
      <p className="m-0 min-w-0 flex-[1_1_160px] text-xs text-fg-1">
        {name}
        {note === null ? null : <span className="text-fg-2"> · {note}</span>}
      </p>
      <span className="flex shrink-0 flex-wrap items-center gap-2">
        {download === null ? null : (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={download}
              download
              className="no-underline"
              aria-label={`${DUB_COPY.download} ${name} in ${language.name}: ${title}`}
            >
              <Download strokeWidth={1.75} aria-hidden="true" />
              {DUB_COPY.download}
            </a>
          </Button>
        )}
        {format.cleanUrl === null ? null : (
          <a
            href={format.cleanUrl}
            download
            className="text-xs text-fg-2"
            aria-label={`${name} in ${language.name} ${DUB_COPY.withoutCaptions.toLowerCase()}: ${title}`}
          >
            {DUB_COPY.withoutCaptions}
          </a>
        )}
        {format.projectId === null ? null : (
          <Link
            href={`/p/${format.projectId}`}
            className="text-xs text-fg-2"
            aria-label={`${DUB_COPY.edit} the ${name} video in ${language.name}: ${title}`}
          >
            {DUB_COPY.edit}
          </Link>
        )}
      </span>
    </li>
  );
}

/** Where a language stands, in a sentence. */
function statusLine(dub: RepurposeDub, language: RepurposeDubLanguageView): string {
  if (language.status === "dubbing") {
    if (dub.progress !== null) return DUB_COPY.dubbingAt(dub.progress, dub.step);
    return dub.step === null ? DUB_COPY.state.dubbing : `${DUB_COPY.state.dubbing} · ${dub.step}`;
  }
  if (language.status === "failed") {
    // The whole dub failed: its reason is said once, under its languages. One
    // language of a dub that was made: the service's reason for that one.
    if (dub.status === "failed" || language.reason === null) return DUB_COPY.state.failed;
    return `${DUB_COPY.state.failed}: ${language.reason}`;
  }
  return DUB_COPY.state[language.status];
}
