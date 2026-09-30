"use client";

/**
 * How a clip did (2026-10-05), on its card: each post of it - on which
 * platform, in which shape (and language), with its views, likes, comments
 * and shares - and where each number came from: measured from the platform,
 * or entered by a person, and when. Posts made from Aksharo arrive by
 * themselves; "I posted this" adds one posted any other way, by its link.
 *
 * Renders nothing while the feature is off for the workspace, or before the
 * clip is made and has no posts, so a card without it looks exactly as it
 * did. Every button here is secondary or ghost: a list of clips would
 * otherwise put a rani button on every card, and the page's one primary
 * stays where it is. Viewers read; editors add, type and remove.
 */
import { BarChart3, ExternalLink, Plus } from "lucide-react";
import * as React from "react";

import { useFeatureFlag, useSession } from "@montaj/api-client";
import { Button, ConfirmAction, Input } from "@montaj/ui";

import {
  PERFORMANCE_COPY,
  compactCount,
  day,
  describePerformanceError,
  metricLabel,
  metricWord,
  percent,
  provenance,
  readingLine,
} from "./copy";
import {
  METRICS,
  PERFORMANCE_FLAG,
  useAddPost,
  useEnterNumbers,
  useRemovePost,
  useRunPerformance,
  type ClipPost,
  type Metric,
  type NumbersRequest,
} from "./use-performance";

export interface ClipPerformanceProps {
  readonly runId: string;
  readonly clipId: string | undefined;
  readonly title: string;
  /** The clip is made: only then can it have been posted. */
  readonly ready: boolean;
}

const SELECT_CLASSNAME =
  "bg-sunken border-neutral-600 text-fg-0 h-9 rounded-sm border px-3 text-sm " +
  "disabled:cursor-not-allowed disabled:text-fg-disabled";

function Numbers({ post }: { readonly post: ClipPost }): React.JSX.Element {
  const shown = METRICS.flatMap((metric) => {
    // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
    const view = post.numbers[metric];
    return view === null ? [] : [{ metric, value: view.value }];
  });
  if (shown.length === 0) {
    return <span className="text-fg-2">{PERFORMANCE_COPY.noNumbersYet}</span>;
  }
  return (
    <span className="text-fg-0" data-testid={`performance-numbers-${post.id}`}>
      {shown.map(({ metric, value }) => `${compactCount(value)} ${metricWord(metric)}`).join(" · ")}
      {post.engagementRate === null ? null : (
        <span className="text-fg-2">
          {" · "}
          {PERFORMANCE_COPY.engagement(percent(post.engagementRate))}
        </span>
      )}
    </span>
  );
}

function NumbersForm({
  runId,
  post,
  onDone,
}: {
  readonly runId: string;
  readonly post: ClipPost;
  readonly onDone: () => void;
}): React.JSX.Element {
  const enter = useEnterNumbers();
  const [values, setValues] = React.useState<Record<Metric, string>>(() => {
    const start = { views: "", likes: "", comments: "", shares: "" };
    for (const metric of METRICS) {
      // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
      const view = post.numbers[metric];
      // eslint-disable-next-line security/detect-object-injection -- as above
      if (view !== null && !view.measured) start[metric] = String(view.value);
    }
    return start;
  });
  const [problem, setProblem] = React.useState<string | null>(null);

  const submit = (): void => {
    const body: { -readonly [K in Metric]?: number } = {};
    for (const metric of METRICS) {
      // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
      const text = values[metric].trim().replace(/,/g, "");
      if (text === "") continue;
      if (!/^\d{1,10}$/.test(text) || Number(text) > 2_147_483_647) {
        setProblem(PERFORMANCE_COPY.numbersInvalid);
        return;
      }
      // eslint-disable-next-line security/detect-object-injection -- as above
      body[metric] = Number(text);
    }
    if (Object.keys(body).length === 0) {
      setProblem(PERFORMANCE_COPY.numbersEmpty);
      return;
    }
    setProblem(null);
    enter.mutate({ runId, postId: post.id, body: body as NumbersRequest }, { onSuccess: onDone });
  };

  const error = problem ?? (enter.isError ? describePerformanceError(enter.error) : null);
  return (
    <form
      className="flex flex-col gap-2 rounded-sm border border-border bg-sunken p-3"
      aria-label={`${PERFORMANCE_COPY.numbersTitle}: ${post.platformLabel}`}
      data-testid={`numbers-form-${post.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="m-0 text-xs text-fg-2">{PERFORMANCE_COPY.numbersHint}</p>
      <div className="flex flex-wrap gap-2">
        {METRICS.map((metric) => (
          <label
            key={metric}
            className="flex min-w-0 flex-[1_1_96px] flex-col gap-1 text-xs font-medium text-fg-1"
          >
            {metricLabel(metric)}
            <Input
              inputMode="numeric"
              // eslint-disable-next-line security/detect-object-injection -- a metric from the closed list
              value={values[metric]}
              onChange={(event) => {
                const next = event.target.value;
                setValues((held) => ({ ...held, [metric]: next }));
              }}
              data-testid={`numbers-${metric}-${post.id}`}
            />
          </label>
        ))}
      </div>
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 text-xs text-rejected"
          data-testid={`numbers-error-${post.id}`}
        >
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={enter.isPending}
          data-testid={`numbers-save-${post.id}`}
        >
          {enter.isPending ? PERFORMANCE_COPY.savingNumbers : PERFORMANCE_COPY.saveNumbers}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {PERFORMANCE_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}

function PostRow({
  runId,
  post,
  canChange,
}: {
  readonly runId: string;
  readonly post: ClipPost;
  readonly canChange: boolean;
}): React.JSX.Element {
  const remove = useRemovePost();
  const [typing, setTyping] = React.useState(false);
  const where = [post.platformLabel, post.shape, post.language].filter(Boolean).join(" · ");
  const sources = provenance(post);
  const reading = readingLine(post);
  return (
    <li
      className="flex flex-col gap-1.5 py-2"
      data-testid={`performance-post-${post.id}`}
      data-reading={post.reading.state}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="m-0 flex min-w-0 flex-[1_1_220px] flex-col gap-0.5 text-sm">
          <span className="text-fg-1">
            {where}
            {post.postedAt === null ? null : (
              <span className="text-fg-2"> · {PERFORMANCE_COPY.postedOn(day(post.postedAt))}</span>
            )}
          </span>
          <Numbers post={post} />
          {sources === "" ? null : (
            <span className="text-xs text-fg-2" data-testid={`performance-sources-${post.id}`}>
              {sources}
            </span>
          )}
          {reading === null ? null : (
            <span className="text-xs text-fg-2" data-testid={`performance-reading-${post.id}`}>
              {reading}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {post.url === null ? null : (
            <Button variant="ghost" size="sm" asChild>
              <a
                href={post.url}
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline"
                aria-label={`${PERFORMANCE_COPY.viewPost} on ${post.platformLabel}`}
                data-testid={`performance-link-${post.id}`}
              >
                {PERFORMANCE_COPY.viewPost}
                <ExternalLink strokeWidth={1.75} aria-hidden="true" />
              </a>
            </Button>
          )}
          {canChange && !typing ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setTyping(true);
              }}
              aria-label={`${PERFORMANCE_COPY.numbersButton}: ${post.platformLabel}`}
              data-testid={`numbers-open-${post.id}`}
            >
              {PERFORMANCE_COPY.numbersButton}
            </Button>
          ) : null}
          {canChange && post.canRemove ? (
            <ConfirmAction
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  aria-label={`${PERFORMANCE_COPY.remove}: ${post.platformLabel}`}
                  data-testid={`performance-remove-${post.id}`}
                >
                  {PERFORMANCE_COPY.remove}
                </Button>
              }
              title={PERFORMANCE_COPY.removeTitle}
              description={PERFORMANCE_COPY.removeDescription}
              confirmLabel={PERFORMANCE_COPY.removeConfirm}
              confirmTestId={`performance-remove-confirm-${post.id}`}
              onConfirm={() => {
                remove.mutate({ runId, postId: post.id });
              }}
            />
          ) : null}
        </div>
      </div>
      {remove.isError ? (
        <p role="alert" className="m-0 text-xs text-rejected">
          {describePerformanceError(remove.error)}
        </p>
      ) : null}
      {typing ? (
        <NumbersForm
          runId={runId}
          post={post}
          onDone={() => {
            setTyping(false);
          }}
        />
      ) : null}
    </li>
  );
}

function AddPostForm({
  runId,
  clipId,
  title,
  shapes,
  languages,
  onDone,
}: {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  readonly shapes: readonly string[];
  readonly languages: readonly string[];
  readonly onDone: () => void;
}): React.JSX.Element {
  const add = useAddPost();
  const [url, setUrl] = React.useState("");
  const [shape, setShape] = React.useState(shapes[0] ?? "9:16");
  const [language, setLanguage] = React.useState("");
  const [postedAt, setPostedAt] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const id = React.useId();

  const error = problem ?? (add.isError ? describePerformanceError(add.error) : null);
  return (
    <form
      className="flex flex-col gap-3 rounded-sm border border-border bg-sunken p-3"
      aria-label={`${PERFORMANCE_COPY.addTitle}: ${title}`}
      data-testid={`add-post-form-${clipId}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim() === "") {
          setProblem(PERFORMANCE_COPY.linkEmpty);
          return;
        }
        setProblem(null);
        add.mutate(
          {
            runId,
            clipId,
            body: {
              url: url.trim(),
              shape,
              ...(language === "" ? {} : { language }),
              ...(postedAt === "" ? {} : { postedAt }),
            },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1" htmlFor={`${id}-url`}>
        {PERFORMANCE_COPY.linkLabel}
        <Input
          id={`${id}-url`}
          value={url}
          placeholder={PERFORMANCE_COPY.linkPlaceholder}
          aria-describedby={`${id}-hint`}
          invalid={error !== null}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          data-testid={`add-post-url-${clipId}`}
        />
        <span id={`${id}-hint`} className="text-xs font-normal text-fg-2">
          {PERFORMANCE_COPY.linkHint}
        </span>
      </label>
      <div className="flex flex-wrap gap-3">
        {shapes.length > 1 ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
            {PERFORMANCE_COPY.shapeLabel}
            <select
              className={SELECT_CLASSNAME}
              value={shape}
              onChange={(event) => {
                setShape(event.target.value);
              }}
              data-testid={`add-post-shape-${clipId}`}
            >
              {shapes.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {languages.length > 0 ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
            {PERFORMANCE_COPY.languageLabel}
            <select
              className={SELECT_CLASSNAME}
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
              }}
              data-testid={`add-post-language-${clipId}`}
            >
              <option value="">{PERFORMANCE_COPY.ownLanguage}</option>
              {languages.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1.5 text-sm font-medium text-fg-1">
          {PERFORMANCE_COPY.postedLabel}
          <Input
            type="date"
            className="w-auto"
            value={postedAt}
            onChange={(event) => {
              setPostedAt(event.target.value);
            }}
            data-testid={`add-post-date-${clipId}`}
          />
        </label>
      </div>
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 text-xs text-rejected"
          data-testid={`add-post-error-${clipId}`}
        >
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={add.isPending}
          data-testid={`add-post-save-${clipId}`}
        >
          {add.isPending ? PERFORMANCE_COPY.saving : PERFORMANCE_COPY.save}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {PERFORMANCE_COPY.cancel}
        </Button>
      </div>
    </form>
  );
}

export function ClipPerformance({
  runId,
  clipId,
  title,
  ready,
}: ClipPerformanceProps): React.JSX.Element | null {
  const on = useFeatureFlag(PERFORMANCE_FLAG);
  const performance = useRunPerformance(runId, on);
  const canChange = (useSession()?.role ?? "viewer") !== "viewer";
  const [adding, setAdding] = React.useState(false);
  const data = performance.data;
  if (!on || data === undefined || !data.enabled || clipId === undefined) return null;
  const posts = data.posts.filter((post) => post.clipId === clipId);
  if (!ready && posts.length === 0) return null;

  const offer = data.clips.find((clip) => clip.clipId === clipId);
  const views = posts.reduce((sum, post) => sum + (post.numbers.views?.value ?? 0), 0);
  const anyViews = posts.some((post) => post.numbers.views !== null);

  return (
    <section
      aria-label={`${PERFORMANCE_COPY.section}: ${title}`}
      className="flex flex-col gap-2 rounded-sm border border-border bg-surface p-3"
      data-testid={`clip-performance-${clipId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 inline-flex items-center gap-1.5 text-sm font-medium text-fg-0">
          <BarChart3 className="size-4 text-fg-2" strokeWidth={1.75} aria-hidden="true" />
          {PERFORMANCE_COPY.section}
          {posts.length === 0 ? null : (
            <span className="text-xs font-normal text-fg-2">
              {PERFORMANCE_COPY.summary(posts.length, anyViews ? compactCount(views) : null)}
            </span>
          )}
        </h4>
        {canChange && ready && !adding ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
            aria-label={`${PERFORMANCE_COPY.addButton}: ${title}`}
            data-testid={`add-post-${clipId}`}
          >
            <Plus strokeWidth={1.75} aria-hidden="true" />
            {PERFORMANCE_COPY.addButton}
          </Button>
        ) : null}
      </div>
      {posts.length === 0 ? null : (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {posts.map((post) => (
            <PostRow key={post.id} runId={runId} post={post} canChange={canChange} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddPostForm
          runId={runId}
          clipId={clipId}
          title={title}
          shapes={offer?.shapes ?? ["9:16"]}
          languages={offer?.languages ?? []}
          onDone={() => {
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}
