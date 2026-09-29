"use client";

/**
 * The compilation builder (2026-10-03), above the run's clip list while the
 * person picks clips (the cards show a tick box each).
 *
 * Two things can be made from the picked clips:
 *
 *   * **a compilation** - one video joining the clips' captioned videos of one
 *     shape, in the order set here (move up / move down), with an optional
 *     title card first. "Best of this video" picks the strongest clips up to a
 *     length. Only clips whose captioned video in the shape is made can be
 *     ticked; the API holds to the same rule;
 *   * **a series** - the clips labelled "Part N of M", numbered in the order
 *     they play in the video, so the order list is shown, not set.
 *
 * One primary button: the one that makes what the tab is about.
 */
import { ArrowDown, ArrowUp, X } from "lucide-react";
import * as React from "react";

import {
  useCreateCompilation,
  useCreateSeries,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
  type RepurposeCompilationShape,
} from "@montaj/api-client";
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

import {
  BEST_OF_TARGETS,
  COMPILATION_COPY,
  COMPILATION_LIMITS,
  COMPILATION_SHAPES,
  SERIES_LIMITS,
  SHAPE_LABELS,
  bestOf,
  defaultBestOfMs,
  formatLength,
  moved,
  pickableClips,
  plannedMs,
} from "@/components/repurpose/compilations";
import { describeRefusal } from "@/components/repurpose/refusal";

export type BuilderMode = "compilation" | "series";

const SELECT_CLASSNAME =
  "bg-sunken border-neutral-600 text-fg-0 h-9 rounded-sm border px-3 text-sm " +
  "disabled:cursor-not-allowed disabled:text-fg-disabled";

export interface CompilationBuilderProps {
  readonly runId: string;
  readonly clips: readonly RepurposeClipItem[];
  readonly candidates: readonly RepurposeCandidateItem[];
  readonly mode: BuilderMode;
  readonly onModeChange: (mode: BuilderMode) => void;
  readonly shape: RepurposeCompilationShape;
  readonly onShapeChange: (shape: RepurposeCompilationShape) => void;
  /** The ticked clips, in the order the compilation plays them. */
  readonly picked: readonly string[];
  readonly onPickedChange: (clipIds: string[]) => void;
  readonly onClose: () => void;
}

export function CompilationBuilder({
  runId,
  clips,
  candidates,
  mode,
  onModeChange,
  shape,
  onShapeChange,
  picked,
  onPickedChange,
  onClose,
}: CompilationBuilderProps): React.JSX.Element {
  const createCompilation = useCreateCompilation();
  const createSeries = useCreateSeries();
  const [title, setTitle] = React.useState("");
  const [target, setTarget] = React.useState(() => defaultBestOfMs(shape));
  const [made, setMade] = React.useState<string | null>(null);

  const pickable = pickableClips(clips, candidates, shape);
  const pickableById = new Map(pickable.map((clip) => [clip.clipId, clip]));
  const titles = new Map(
    clips.map((clip) => {
      const candidate = candidates.find((entry) => entry.id === clip.candidateId);
      return [clip.id, candidate?.title ?? clip.title ?? "Clip"] as const;
    }),
  );
  const startOf = (clipId: string): number => {
    const clip = clips.find((entry) => entry.id === clipId);
    return clip?.sourceStartMs ?? 0;
  };

  const withTitle = title.trim() !== "";
  const durations = picked.map((clipId) => pickableById.get(clipId)?.durationMs ?? 0);
  const lengthMs = plannedMs(durations, withTitle);
  const tooLong = lengthMs > COMPILATION_LIMITS.maxOutputMs;
  const tooFew = picked.length < COMPILATION_LIMITS.minClips;
  const seriesOrder = [...picked].sort((a, b) => startOf(a) - startOf(b));
  const seriesTooMany = picked.length > SERIES_LIMITS.maxClips;

  const compilationError = createCompilation.isError
    ? describeRefusal(createCompilation.error, "compilation")
    : null;
  const seriesError = createSeries.isError ? describeRefusal(createSeries.error, "series") : null;

  const makeCompilation = (): void => {
    setMade(null);
    createCompilation.mutate(
      {
        runId,
        body: {
          clipIds: [...picked],
          shape,
          ...(withTitle ? { title: title.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          setTitle("");
          onPickedChange([]);
          onClose();
        },
      },
    );
  };

  const makeSeries = (): void => {
    setMade(null);
    createSeries.mutate(
      { runId, clipIds: seriesOrder },
      {
        onSuccess: () => {
          setMade(COMPILATION_COPY.seriesMade);
          onPickedChange([]);
        },
      },
    );
  };

  return (
    <section
      aria-label={COMPILATION_COPY.builderHeading}
      className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4"
      data-testid="compilation-builder"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold text-fg-0">{COMPILATION_COPY.builderHeading}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="compilation-builder-close">
          {COMPILATION_COPY.cancel}
        </Button>
      </div>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          onModeChange(value === "series" ? "series" : "compilation");
        }}
      >
        <TabsList>
          <TabsTrigger value="compilation" data-testid="builder-mode-compilation">
            {COMPILATION_COPY.compilationTab}
          </TabsTrigger>
          <TabsTrigger value="series" data-testid="builder-mode-series">
            {COMPILATION_COPY.seriesTab}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="compilation" className="flex flex-col gap-4 pt-3">
          <p className="m-0 text-sm text-fg-2">
            {COMPILATION_COPY.pickHint} {COMPILATION_COPY.onlyCaptioned}
          </p>
          {pickable.length >= COMPILATION_LIMITS.minClips ? null : (
            <p className="m-0 text-sm text-fg-1" role="status" data-testid="compilation-none-ready">
              {COMPILATION_COPY.noneReady}
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
              {COMPILATION_COPY.shape}
              <select
                className={SELECT_CLASSNAME}
                value={shape}
                data-testid="compilation-shape"
                onChange={(event) => {
                  const next = COMPILATION_SHAPES.find((entry) => entry === event.target.value);
                  if (next === undefined) return;
                  onShapeChange(next);
                  setTarget(defaultBestOfMs(next));
                }}
              >
                {COMPILATION_SHAPES.map((entry) => (
                  <option key={entry} value={entry}>
                    {/* eslint-disable-next-line security/detect-object-injection -- a closed enum of shapes */}
                    {SHAPE_LABELS[entry]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
              {COMPILATION_COPY.length}
              <select
                className={SELECT_CLASSNAME}
                value={String(target)}
                data-testid="compilation-target"
                onChange={(event) => {
                  setTarget(Number(event.target.value));
                }}
              >
                {BEST_OF_TARGETS.map((entry) => (
                  <option key={entry.ms} value={String(entry.ms)}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={pickable.length < COMPILATION_LIMITS.minClips}
              onClick={() => {
                onPickedChange(bestOf(pickable, target, withTitle));
              }}
              data-testid="compilation-best-of"
            >
              {COMPILATION_COPY.bestOf}
            </Button>
          </div>

          <OrderList
            picked={picked}
            titles={titles}
            lengths={pickableById}
            editable
            onChange={onPickedChange}
          />

          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
            {COMPILATION_COPY.title}
            <Input
              value={title}
              maxLength={COMPILATION_LIMITS.titleMax}
              placeholder="Best of the episode"
              className="border-neutral-600 bg-sunken"
              data-testid="compilation-title"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <span className="text-xs font-normal text-fg-2">{COMPILATION_COPY.titleHint}</span>
          </label>

          <p className="m-0 text-sm text-fg-1" data-testid="compilation-summary" role="status">
            {picked.length === 0
              ? COMPILATION_COPY.none
              : `${String(picked.length)} ${picked.length === 1 ? "clip" : "clips"} · ${formatLength(lengthMs)}`}
            {tooLong ? ` ${COMPILATION_COPY.tooLong}` : ""}
            {!tooLong && picked.length > 0 && tooFew ? ` ${COMPILATION_COPY.needTwo}` : ""}
          </p>

          {compilationError === null ? null : (
            <p role="alert" className="m-0 text-sm text-rejected" data-testid="compilation-error">
              {compilationError.text}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={tooFew || tooLong || createCompilation.isPending}
              onClick={makeCompilation}
              data-testid="compilation-create"
            >
              {createCompilation.isPending ? COMPILATION_COPY.creating : COMPILATION_COPY.create}
            </Button>
            <span className="text-xs text-fg-2">{COMPILATION_COPY.tooMany}</span>
          </div>
        </TabsContent>

        <TabsContent value="series" className="flex flex-col gap-4 pt-3">
          <p className="m-0 text-sm text-fg-2">{COMPILATION_COPY.seriesHint}</p>
          <OrderList picked={seriesOrder} titles={titles} numbered onChange={onPickedChange} />
          {seriesTooMany ? (
            <p className="m-0 text-sm text-fg-1" role="status">
              {COMPILATION_COPY.seriesTooMany}
            </p>
          ) : null}
          {seriesError === null ? null : (
            <p role="alert" className="m-0 text-sm text-rejected" data-testid="series-error">
              {seriesError.text}
            </p>
          )}
          {made === null ? null : (
            <p role="status" className="m-0 text-sm text-fg-1" data-testid="series-made">
              {made}
            </p>
          )}
          <div>
            <Button
              variant="primary"
              disabled={
                picked.length < SERIES_LIMITS.minClips || seriesTooMany || createSeries.isPending
              }
              onClick={makeSeries}
              data-testid="series-create"
            >
              {createSeries.isPending
                ? COMPILATION_COPY.creatingSeries
                : COMPILATION_COPY.createSeries}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

/**
 * The picked clips in order. Editable: each can move up, down or out (a
 * compilation's order is the person's); numbered: "Part 1", "Part 2" (a
 * series' order is the video's).
 */
function OrderList({
  picked,
  titles,
  lengths,
  editable = false,
  numbered = false,
  onChange,
}: {
  readonly picked: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
  readonly lengths?: ReadonlyMap<string, { readonly durationMs: number }>;
  readonly editable?: boolean;
  readonly numbered?: boolean;
  readonly onChange: (clipIds: string[]) => void;
}): React.JSX.Element | null {
  if (picked.length === 0) return null;
  return (
    <ol
      aria-label={COMPILATION_COPY.order}
      className="m-0 flex list-none flex-col gap-1.5 p-0"
      data-testid={editable ? "compilation-order" : "series-order"}
    >
      {picked.map((clipId, index) => {
        const title = titles.get(clipId) ?? "Clip";
        const length = lengths?.get(clipId)?.durationMs;
        return (
          <li
            key={clipId}
            className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-bg-0 px-2 py-1.5"
            data-testid={`order-${clipId}`}
          >
            <span className="w-14 shrink-0 font-mono text-2xs text-fg-2">
              {numbered ? `Part ${String(index + 1)}` : `${String(index + 1)}.`}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg-0">{title}</span>
            {length === undefined ? null : (
              <span className="shrink-0 font-mono text-2xs text-fg-2">{formatLength(length)}</span>
            )}
            {editable ? (
              <span className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  aria-label={`${COMPILATION_COPY.moveUp}: ${title}`}
                  onClick={() => {
                    onChange(moved(picked, index, -1));
                  }}
                  data-testid={`order-up-${clipId}`}
                >
                  <ArrowUp strokeWidth={1.75} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === picked.length - 1}
                  aria-label={`${COMPILATION_COPY.moveDown}: ${title}`}
                  onClick={() => {
                    onChange(moved(picked, index, 1));
                  }}
                  data-testid={`order-down-${clipId}`}
                >
                  <ArrowDown strokeWidth={1.75} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${COMPILATION_COPY.remove}: ${title}`}
                  onClick={() => {
                    onChange(picked.filter((entry) => entry !== clipId));
                  }}
                  data-testid={`order-remove-${clipId}`}
                >
                  <X strokeWidth={1.75} aria-hidden="true" />
                </Button>
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
