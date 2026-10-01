"use client";

/**
 * The voice-over hook (2026-10-01, OpusClip parity wave 4), on a clip's card:
 * the "Add a voice-over hook" action and, once asked for, the clip's
 * Voice-over row.
 *
 * The dialog shows the line the voice will say (the clip's hook, which the
 * person may change), the voice, and what it costs, before anything is asked
 * for - the voice, and making the clip's finished videos again with it, which
 * is charged as any video is. The row says where the voice-over stands - waiting for a free slot,
 * being made, added (with a player for the voice on its own and how many of
 * the clip's sizes carry it), or what went wrong with "Try again" - and offers
 * "Take it off" behind a confirmation, since adding one again costs again.
 *
 * Nothing shows while voice-overs are switched off for the workspace (the
 * `repurpose_voiceover` flag) and the clip has none; a clip that was given one
 * before the switch went off keeps its row, so it can still be taken off.
 */
import { AlertTriangle, Loader2, Mic } from "lucide-react";
import * as React from "react";

import {
  useCreateRepurposeVoiceover,
  useRemoveRepurposeVoiceover,
  useRepurposeVoiceovers,
  useRetryRepurposeVoiceover,
  type RepurposeVoiceover,
  type RepurposeVoiceoverList,
  type RepurposeVoiceoverOffer,
  type RepurposeVoiceoverSpeakerId,
} from "@montaj/api-client";
import {
  Button,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Textarea,
} from "@montaj/ui";

import {
  VOICEOVER_COPY,
  voiceoverCostText,
  voiceoverFailureCopy,
  voiceoverRefusalCopy,
} from "@/components/repurpose/voiceover/copy";

/**
 * What the server also says about the cost (2026-10-01): the clip's existing
 * captioned videos that adding the voice makes again, and the render rate.
 * Optional, so an older server's answer still reads.
 */
type CostedOffer = RepurposeVoiceoverOffer & {
  readonly rerenderVideos?: number;
  readonly rerenderTenths?: number;
};
type CostedList = RepurposeVoiceoverList & { readonly renderTenthsPerMinute?: number };

const SELECT_CLASSNAME =
  "bg-sunken border-neutral-600 text-fg-0 h-9 w-full rounded-sm border px-3 text-sm " +
  "disabled:cursor-not-allowed disabled:text-fg-disabled";

export interface ClipVoiceoverProps {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  /** Whether a new voice-over may be asked for: not on a stopped run or a clip not made yet. */
  readonly offerNew?: boolean;
}

/** Reads the run's voice-overs (one request for every card of the run) and shows this clip's. */
export function ClipVoiceover(props: ClipVoiceoverProps): React.JSX.Element | null {
  const query = useRepurposeVoiceovers(props.runId);
  if (query.data === undefined) return null;
  return <ClipVoiceoverView {...props} list={query.data} />;
}

export function ClipVoiceoverView({
  runId,
  clipId,
  title,
  list,
  offerNew = true,
}: ClipVoiceoverProps & { readonly list: RepurposeVoiceoverList }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const offer = list.clips.find((entry) => entry.clipId === clipId);
  const voiceover = list.voiceovers.find(
    (entry) => entry.clipId === clipId && entry.status !== "removed",
  );
  const canAdd =
    list.enabled &&
    offerNew &&
    offer !== undefined &&
    offer.ready &&
    offer.language !== null &&
    voiceover === undefined;
  if (!canAdd && voiceover === undefined) return null;

  return (
    <div className="flex flex-col gap-2" data-testid={`clip-voiceover-${clipId}`}>
      {canAdd ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            aria-label={`${VOICEOVER_COPY.button}: ${title}`}
            data-testid={`voiceover-add-${clipId}`}
          >
            <Mic strokeWidth={1.75} aria-hidden="true" />
            {VOICEOVER_COPY.button}
          </Button>
          <VoiceoverDialog
            runId={runId}
            offer={offer}
            list={list}
            title={title}
            open={open}
            onOpenChange={setOpen}
          />
        </div>
      ) : null}
      {voiceover === undefined ? null : (
        <VoiceoverRow runId={runId} title={title} voiceover={voiceover} />
      )}
    </div>
  );
}

function VoiceoverDialog({
  runId,
  offer,
  list,
  title,
  open,
  onOpenChange,
}: {
  readonly runId: string;
  readonly offer: RepurposeVoiceoverOffer;
  readonly list: RepurposeVoiceoverList;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const create = useCreateRepurposeVoiceover();
  const [text, setText] = React.useState(offer.text);
  const [speaker, setSpeaker] = React.useState<RepurposeVoiceoverSpeakerId>(
    list.speakers[0]?.id ?? "priya",
  );
  const trimmed = text.replace(/\s+/gu, " ").trim();
  const tooShort = trimmed.length < 2;
  const left = Math.max(0, list.maxTextChars - text.length);
  const refusal = create.isError ? voiceoverRefusalCopy(create.error) : null;
  const textId = `voiceover-text-${offer.clipId}`;
  const speakerId = `voiceover-speaker-${offer.clipId}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setText(offer.text);
          create.reset();
        }
      }}
    >
      <DialogContent className="max-w-lg" data-testid={`voiceover-dialog-${offer.clipId}`}>
        <DialogHeader>
          <DialogTitle>{VOICEOVER_COPY.dialogTitle}</DialogTitle>
          <DialogDescription>
            {VOICEOVER_COPY.dialogDescription(offer.language?.name ?? "")}
          </DialogDescription>
        </DialogHeader>

        <Field
          label={VOICEOVER_COPY.textLabel}
          htmlFor={textId}
          hint={VOICEOVER_COPY.textHint(left)}
        >
          <Textarea
            id={textId}
            value={text}
            maxLength={list.maxTextChars}
            rows={3}
            disabled={create.isPending}
            onChange={(event) => {
              setText(event.target.value);
            }}
            data-testid="voiceover-text"
          />
        </Field>

        <Field label={VOICEOVER_COPY.speakerLabel} htmlFor={speakerId}>
          <select
            id={speakerId}
            className={SELECT_CLASSNAME}
            value={speaker}
            disabled={create.isPending}
            onChange={(event) => {
              setSpeaker(event.target.value as RepurposeVoiceoverSpeakerId);
            }}
            data-testid="voiceover-speaker"
          >
            {list.speakers.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Field>

        <p className="m-0 text-sm text-fg-1" data-testid="voiceover-cost">
          {voiceoverCostText({
            tenths: list.tenthsPerVoiceover,
            rerenderVideos: (offer as CostedOffer).rerenderVideos,
            rerenderTenths: (offer as CostedOffer).rerenderTenths,
            renderTenthsPerMinute: (list as CostedList).renderTenthsPerMinute,
          })}
        </p>

        {refusal === null ? null : (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="voiceover-error">
            {refusal}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {VOICEOVER_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={tooShort || create.isPending}
            aria-label={create.isPending ? undefined : `${VOICEOVER_COPY.confirm}: ${title}`}
            onClick={() => {
              create.mutate(
                {
                  runId,
                  clipId: offer.clipId,
                  // The clip's own line is sent as nothing, so the server's word for it is used.
                  body: { ...(trimmed === offer.text ? {} : { text: trimmed }), speaker },
                },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                  },
                },
              );
            }}
            data-testid="voiceover-confirm"
          >
            {create.isPending ? VOICEOVER_COPY.confirming : VOICEOVER_COPY.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoiceoverRow({
  runId,
  title,
  voiceover,
}: {
  readonly runId: string;
  readonly title: string;
  readonly voiceover: RepurposeVoiceover;
}): React.JSX.Element {
  const retry = useRetryRepurposeVoiceover();
  const remove = useRemoveRepurposeVoiceover();
  const refusal = retry.isError
    ? voiceoverRefusalCopy(retry.error)
    : remove.isError
      ? voiceoverRefusalCopy(remove.error)
      : null;
  const busy = voiceover.status === "waiting" || voiceover.status === "speaking";
  return (
    <section
      className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3"
      aria-label={VOICEOVER_COPY.section}
      data-testid={`voiceover-${voiceover.id}`}
      data-state={voiceover.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{VOICEOVER_COPY.section}</span>
        <span className="text-fg-2" data-testid={`voiceover-status-${voiceover.id}`}>
          {busy ? (
            <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" />
          ) : null}
          {voiceover.status === "failed" ? (
            <AlertTriangle className="mr-1 inline size-3.5" aria-hidden="true" />
          ) : null}
          {VOICEOVER_COPY.state[voiceover.status]}
        </span>
      </div>
      <p className="m-0 text-sm text-fg-1">“{voiceover.text}”</p>
      {voiceover.status === "ready" ? (
        <>
          {voiceover.audioUrl === null ? null : (
            <audio
              controls
              preload="none"
              src={voiceover.audioUrl}
              aria-label={VOICEOVER_COPY.player(title)}
              className="w-full"
              data-testid={`voiceover-player-${voiceover.id}`}
            />
          )}
          <p className="m-0 text-xs text-fg-2" data-testid={`voiceover-placed-${voiceover.id}`}>
            {voiceover.placedShapes > 0
              ? VOICEOVER_COPY.placed(voiceover.placedShapes)
              : VOICEOVER_COPY.placing}
          </p>
        </>
      ) : null}
      {voiceover.status === "failed" ? (
        <p className="m-0 text-sm text-fg-1" data-testid={`voiceover-failure-${voiceover.id}`}>
          {voiceoverFailureCopy(voiceover.failureCode, voiceover.failureMessage)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {voiceover.canRetry ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={retry.isPending}
            onClick={() => {
              retry.mutate({ runId, voiceoverId: voiceover.id });
            }}
            data-testid={`voiceover-retry-${voiceover.id}`}
          >
            {retry.isPending ? VOICEOVER_COPY.retrying : VOICEOVER_COPY.retry}
          </Button>
        ) : null}
        {voiceover.canRemove ? (
          <ConfirmAction
            trigger={
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                data-testid={`voiceover-remove-${voiceover.id}`}
              >
                {VOICEOVER_COPY.remove}
              </Button>
            }
            title={VOICEOVER_COPY.removeTitle}
            description={VOICEOVER_COPY.removeDescription}
            confirmLabel={VOICEOVER_COPY.removeConfirm}
            confirmTestId={`voiceover-remove-confirm-${voiceover.id}`}
            onConfirm={() =>
              remove.mutateAsync({ runId, voiceoverId: voiceover.id }).catch(() => undefined)
            }
          />
        ) : null}
      </div>
      {refusal === null ? null : (
        <p
          role="alert"
          className="m-0 text-sm text-rejected"
          data-testid={`voiceover-error-${voiceover.id}`}
        >
          {refusal}
        </p>
      )}
    </section>
  );
}
