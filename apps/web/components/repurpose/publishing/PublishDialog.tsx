"use client";

/**
 * "Post this clip" (2026-09-29): which accounts, the words for each platform,
 * and when - now, at a picked time, or on the next free day at 7 pm.
 *
 * Nothing is chosen for the person: no account starts ticked (D60's rule for
 * anything that acts on their behalf), and nothing goes out until the primary
 * button is pressed. Each account shows the video shape it will get, or why it
 * cannot take this clip. The text starts from the clip's own copy and is theirs
 * to change; the counter counts the way the platform does.
 *
 * The dialog is its own surface, so its confirm is the one primary button in
 * it; the page's own primary is untouched.
 *
 * While the workspace needs approval before posting (2026-10-03) and this clip
 * is not approved, the dialog says so instead of offering accounts: the API
 * would refuse the post (`publishing/not_approved`).
 */
import { AlertTriangle, Loader2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Textarea,
  toast,
} from "@montaj/ui";

import {
  PUBLISH_COPY,
  TEXT_LABEL,
  UNAVAILABLE_COPY,
  describePublishError,
  formatClock,
  formatWhen,
  textLength,
} from "./publish-copy";
import {
  newIdempotencyKey,
  usePublishClip,
  usePublishPlan,
  type PlanChannel,
  type PlanText,
  type PublishPlan,
  type PublishProvider,
  type PublishRequest,
  type PublishVisibility,
} from "./use-publishing";

import { INLINE_LINK_CLASS } from "@/components/settings/section";

const INDIA = "Asia/Kolkata";
const SELECT_CLASS =
  "h-9 w-full rounded-sm border border-neutral-600 bg-sunken px-3 text-sm text-fg-0 hover:border-border-hover";

type WhenKind = "now" | "at" | "daily";

interface DraftText {
  readonly title: string;
  readonly body: string;
}

export interface PublishDialogProps {
  readonly runId: string;
  readonly clipId: string;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** `2026-10-02T19:00` for a datetime input, in the viewer's own clock. */
function localInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Why this text cannot go, or null. The server checks again. */
function textProblem(provider: PublishProvider, text: DraftText, rules: PlanText): string | null {
  // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
  const label = TEXT_LABEL[provider];
  if (text.body.trim() === "") return `Write the ${label.body.toLowerCase()}.`;
  if (textLength(text.body.trim(), rules.linkLength) > rules.bodyLimit) {
    return `The ${label.body.toLowerCase()} is too long.`;
  }
  if (rules.titleLimit !== null) {
    const length = [...text.title.trim()].length;
    if (rules.titleRequired && length < 2)
      return `Give it a ${(label.title ?? "title").toLowerCase()}.`;
    if (length > rules.titleLimit)
      return `The ${(label.title ?? "title").toLowerCase()} is too long.`;
  }
  return null;
}

/** Channels grouped under their platform, in the order they came. */
function groupByPlatform(channels: readonly PlanChannel[]): [string, PlanChannel[]][] {
  const groups = new Map<string, PlanChannel[]>();
  for (const channel of channels) {
    const list = groups.get(channel.platform) ?? [];
    list.push(channel);
    groups.set(channel.platform, list);
  }
  return [...groups.entries()];
}

function initialOf(name: string): string {
  return (name.trim().charAt(0) || "?").toUpperCase();
}

function ChannelRow({
  channel,
  checked,
  onToggle,
}: {
  readonly channel: PlanChannel;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
}): React.JSX.Element {
  const id = `publish-channel-${channel.id ?? channel.name}`;
  const detail = channel.shape === null ? channel.surface : `${channel.surface} · ${channel.shape}`;
  return (
    <li
      className="flex items-start gap-3 py-1.5"
      data-testid={`publish-channel-${channel.id ?? "none"}`}
    >
      <Checkbox
        id={id}
        className="mt-1"
        checked={checked}
        disabled={!channel.ready}
        onCheckedChange={(value) => {
          onToggle(value === true);
        }}
        aria-describedby={channel.note === null ? undefined : `${id}-note`}
      />
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-2 text-xs font-medium text-fg-1"
      >
        {channel.avatarUrl === null ? (
          initialOf(channel.name)
        ) : (
          <img src={channel.avatarUrl} alt="" className="size-full object-cover" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm text-fg-0">
          {channel.name}
          {channel.username === null || channel.username === channel.name ? null : (
            <>
              {" "}
              <span className="text-fg-2">@{channel.username}</span>
            </>
          )}
        </label>
        <span className="block text-xs text-fg-2">{detail}</span>
        {channel.note === null ? null : (
          <span id={`${id}-note`} className="block text-xs text-fg-2">
            {channel.note}
          </span>
        )}
      </span>
    </li>
  );
}

function TextFields({
  provider,
  rules,
  value,
  onChange,
}: {
  readonly provider: PublishProvider;
  readonly rules: PlanText;
  readonly value: DraftText;
  readonly onChange: (next: DraftText) => void;
}): React.JSX.Element {
  // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
  const label = TEXT_LABEL[provider];
  const length = textLength(value.body.trim(), rules.linkLength);
  const over = length > rules.bodyLimit;
  return (
    <div className="flex flex-col gap-3" data-testid={`publish-text-${provider}`}>
      {rules.titleLimit === null || label.title === undefined ? null : (
        <Field label={label.title} htmlFor={`publish-title-${provider}`}>
          <Input
            id={`publish-title-${provider}`}
            value={value.title}
            maxLength={rules.titleLimit + 20}
            invalid={[...value.title.trim()].length > rules.titleLimit}
            onChange={(event) => {
              onChange({ ...value, title: event.target.value });
            }}
          />
        </Field>
      )}
      <Field label={label.body} htmlFor={`publish-body-${provider}`}>
        <Textarea
          id={`publish-body-${provider}`}
          rows={4}
          value={value.body}
          aria-invalid={over}
          aria-describedby={`publish-count-${provider}`}
          onChange={(event) => {
            onChange({ ...value, body: event.target.value });
          }}
        />
      </Field>
      <p
        id={`publish-count-${provider}`}
        className={over ? "m-0 -mt-2 text-xs text-rejected" : "m-0 -mt-2 text-xs text-fg-2"}
        data-testid={`publish-count-${provider}`}
      >
        {length.toLocaleString("en-IN")} / {rules.bodyLimit.toLocaleString("en-IN")}
      </p>
    </div>
  );
}

function PublishForm({
  runId,
  clipId,
  plan,
  onDone,
  onCancel,
}: {
  readonly runId: string;
  readonly clipId: string;
  readonly plan: PublishPlan;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const publish = usePublishClip();
  const key = React.useRef(newIdempotencyKey());
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [texts, setTexts] = React.useState<Partial<Record<PublishProvider, DraftText>>>(() => {
    const initial: Partial<Record<PublishProvider, DraftText>> = {};
    for (const [provider, text] of Object.entries(plan.texts) as [PublishProvider, PlanText][]) {
      // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
      initial[provider] = { title: text.title ?? "", body: text.body };
    }
    return initial;
  });
  const [visibility, setVisibility] = React.useState<Required<PublishVisibility>>({
    youtube: plan.visibility.youtube,
    tiktok: plan.visibility.tiktok,
  });
  const [when, setWhen] = React.useState<WhenKind>("now");
  const [at, setAt] = React.useState(() => localInputValue(new Date(Date.now() + 60 * 60_000)));
  const [dailyTime, setDailyTime] = React.useState(plan.defaults.dailyTime);

  const chosen = plan.channels.filter((channel) => channel.id !== null && selected.has(channel.id));
  const providers = [
    ...new Set(
      chosen.map((channel) => channel.provider).filter((p): p is PublishProvider => p !== null),
    ),
  ];
  const problems = providers
    .map((provider) => {
      // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
      const rules = plan.texts[provider];
      // eslint-disable-next-line security/detect-object-injection -- as above
      const text = texts[provider];
      return rules === undefined || text === undefined ? null : textProblem(provider, text, rules);
    })
    .filter((problem): problem is string => problem !== null);
  const atDate = new Date(at);
  const timeProblem =
    when === "at" && (Number.isNaN(atDate.getTime()) || atDate.getTime() < Date.now() + 2 * 60_000)
      ? "Pick a time at least a few minutes from now."
      : when === "daily" && !/^\d{2}:\d{2}$/.test(dailyTime)
        ? "Pick a time of day."
        : null;
  const blocked = chosen.length === 0 || problems.length > 0 || timeProblem !== null;
  const readyCount = plan.channels.filter((channel) => channel.ready).length;

  const submit = (): void => {
    const body: PublishRequest = {
      channelIds: chosen.map((channel) => channel.id as string),
      texts: Object.fromEntries(
        providers.map((provider) => {
          // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
          const text = texts[provider] ?? { title: "", body: "" };
          // eslint-disable-next-line security/detect-object-injection -- as above
          const hasTitle = plan.texts[provider]?.titleLimit !== null;
          return [
            provider,
            hasTitle ? { title: text.title.trim(), body: text.body } : { body: text.body },
          ];
        }),
      ),
      visibility: {
        ...(providers.includes("youtube") ? { youtube: visibility.youtube } : {}),
        ...(providers.includes("tiktok") ? { tiktok: visibility.tiktok } : {}),
      },
      when:
        when === "now"
          ? { kind: "now" }
          : when === "at"
            ? { kind: "at", at: atDate.toISOString(), timezone: viewerZone() }
            : { kind: "daily", time: dailyTime, timezone: INDIA },
    };
    publish.mutate(
      { runId, clipId, body, idempotencyKey: key.current },
      {
        onSuccess: (result) => {
          key.current = newIdempotencyKey();
          const first = result.posts[0];
          toast.success(
            when === "now"
              ? result.posts.length === 1
                ? "Posting now."
                : `Posting to ${String(result.posts.length)} accounts.`
              : first?.scheduledAt === null || first === undefined
                ? "Scheduled."
                : `Scheduled from ${formatWhen(first.scheduledAt)}.`,
          );
          onDone();
        },
      },
    );
  };

  return (
    <>
      <div className="flex flex-col gap-5">
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-fg-1">{PUBLISH_COPY.where}</legend>
          {readyCount === 0 ? (
            <p className="m-0 mb-2 text-sm text-fg-2" data-testid="publish-none-ready">
              {PUBLISH_COPY.noReadyChannel}
            </p>
          ) : null}
          <div className="flex flex-col gap-3">
            {groupByPlatform(plan.channels).map(([platform, channels]) => (
              <div key={platform}>
                <h3 className="m-0 text-xs font-medium tracking-wide text-fg-2 uppercase">
                  {platform}
                </h3>
                <ul className="m-0 list-none p-0">
                  {channels.map((channel) => (
                    <ChannelRow
                      key={channel.id ?? channel.name}
                      channel={channel}
                      checked={channel.id !== null && selected.has(channel.id)}
                      onToggle={(checked) => {
                        if (channel.id === null) return;
                        const next = new Set(selected);
                        if (checked) next.add(channel.id);
                        else next.delete(channel.id);
                        setSelected(next);
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </fieldset>

        {providers.length === 0 ? null : (
          <section className="flex flex-col gap-4" aria-label={PUBLISH_COPY.text}>
            {providers.map((provider) => {
              // eslint-disable-next-line security/detect-object-injection -- `provider` is a closed union
              const rules = plan.texts[provider];
              // eslint-disable-next-line security/detect-object-injection -- as above
              const value = texts[provider];
              if (rules === undefined || value === undefined) return null;
              return (
                <TextFields
                  key={provider}
                  provider={provider}
                  rules={rules}
                  value={value}
                  onChange={(next) => {
                    setTexts({ ...texts, [provider]: next });
                  }}
                />
              );
            })}
            {providers.includes("youtube") ? (
              <Field label={PUBLISH_COPY.youtubeVisibility} htmlFor="publish-visibility-youtube">
                <select
                  id="publish-visibility-youtube"
                  className={SELECT_CLASS}
                  value={visibility.youtube}
                  onChange={(event) => {
                    setVisibility({
                      ...visibility,
                      youtube: event.target.value as Required<PublishVisibility>["youtube"],
                    });
                  }}
                >
                  <option value="public">Everyone</option>
                  <option value="unlisted">Anyone with the link</option>
                  <option value="private">Only me</option>
                </select>
              </Field>
            ) : null}
            {providers.includes("tiktok") ? (
              <Field
                label={PUBLISH_COPY.tiktokVisibility}
                htmlFor="publish-visibility-tiktok"
                hint={PUBLISH_COPY.tiktokNote}
              >
                <select
                  id="publish-visibility-tiktok"
                  className={SELECT_CLASS}
                  value={visibility.tiktok}
                  onChange={(event) => {
                    setVisibility({
                      ...visibility,
                      tiktok: event.target.value as Required<PublishVisibility>["tiktok"],
                    });
                  }}
                >
                  <option value="private">Only me</option>
                  <option value="friends">Friends</option>
                  <option value="public">Everyone</option>
                </select>
              </Field>
            ) : null}
          </section>
        )}

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-fg-1">{PUBLISH_COPY.whenLegend}</legend>
          {(
            [
              ["now", PUBLISH_COPY.whenNow],
              ["at", PUBLISH_COPY.whenAt],
              ["daily", PUBLISH_COPY.whenDaily],
            ] as const
          ).map(([kind, label]) => (
            <label key={kind} className="flex items-center gap-2 text-sm text-fg-0">
              <input
                type="radio"
                name="publish-when"
                className="size-4 accent-accent"
                value={kind}
                checked={when === kind}
                onChange={() => {
                  setWhen(kind);
                }}
                data-testid={`publish-when-${kind}`}
              />
              {label}
            </label>
          ))}
          {when === "at" ? (
            <Field
              label="Date and time"
              htmlFor="publish-at"
              hint={PUBLISH_COPY.atHint(viewerZone())}
              {...(timeProblem === null ? {} : { error: timeProblem })}
            >
              <Input
                id="publish-at"
                type="datetime-local"
                value={at}
                onChange={(event) => {
                  setAt(event.target.value);
                }}
              />
            </Field>
          ) : null}
          {when === "daily" ? (
            <div className="flex flex-col gap-2">
              <Field
                label="Time of day"
                htmlFor="publish-daily-time"
                hint={PUBLISH_COPY.dailyHint(formatClock(dailyTime))}
              >
                <Input
                  id="publish-daily-time"
                  type="time"
                  value={dailyTime}
                  className="w-36"
                  onChange={(event) => {
                    setDailyTime(event.target.value);
                  }}
                />
              </Field>
              {dailyTime === plan.defaults.dailyTime && chosen.length > 0 ? (
                <ul
                  className="m-0 list-none p-0 text-xs text-fg-2"
                  data-testid="publish-next-daily"
                >
                  {chosen.map((channel) => {
                    const next = channel.id === null ? undefined : plan.nextDaily[channel.id];
                    return next === undefined ? null : (
                      <li key={channel.id}>
                        {channel.platform}, {channel.name}: {formatWhen(next, INDIA)}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        {problems.length > 0 && chosen.length > 0 ? (
          <ul className="m-0 list-none p-0 text-sm text-rejected" data-testid="publish-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {publish.isError ? (
          <p
            role="alert"
            className="m-0 flex items-start gap-2 text-sm text-rejected"
            data-testid="publish-error"
          >
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            {describePublishError(publish.error)}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {PUBLISH_COPY.cancel}
        </Button>
        <Button
          variant="primary"
          disabled={blocked || publish.isPending}
          onClick={submit}
          data-testid="publish-confirm"
        >
          {publish.isPending
            ? PUBLISH_COPY.sending
            : when === "now"
              ? PUBLISH_COPY.confirmNow(chosen.length)
              : when === "at"
                ? PUBLISH_COPY.confirmAt
                : PUBLISH_COPY.confirmDaily}
        </Button>
      </DialogFooter>
    </>
  );
}

export function PublishDialog({
  runId,
  clipId,
  title,
  open,
  onOpenChange,
}: PublishDialogProps): React.JSX.Element {
  const plan = usePublishPlan(runId, clipId, open);
  const close = (): void => {
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[88vh] max-w-2xl overflow-y-auto"
        data-testid="publish-dialog"
      >
        <DialogHeader>
          <DialogTitle>{PUBLISH_COPY.dialogTitle}</DialogTitle>
          <DialogDescription>
            <span className="block truncate text-fg-1">{title}</span>
            {PUBLISH_COPY.dialogDescription}
          </DialogDescription>
        </DialogHeader>
        {plan.isLoading ? (
          <p role="status" className="m-0 inline-flex items-center gap-2 text-sm text-fg-2">
            <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            {PUBLISH_COPY.loading}
          </p>
        ) : plan.isError || plan.data === undefined ? (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="publish-plan-error">
            {describePublishError(plan.error)}
          </p>
        ) : plan.data.status.available &&
          plan.data.approval !== undefined &&
          plan.data.approval.required &&
          !plan.data.approval.approved ? (
          <div className="flex flex-col gap-2" data-testid="publish-needs-approval">
            <p className="m-0 text-sm text-fg-0">
              {plan.data.approval.message ?? PUBLISH_COPY.needsApproval}
            </p>
            <p className="m-0 text-sm text-fg-2">{PUBLISH_COPY.approveHere}</p>
          </div>
        ) : !plan.data.status.available ? (
          <p className="m-0 text-sm text-fg-1" data-testid="publish-unavailable">
            {plan.data.status.reason === null
              ? UNAVAILABLE_COPY.not_configured
              : UNAVAILABLE_COPY[plan.data.status.reason]}{" "}
            <Link href="/settings/publishing" className={INLINE_LINK_CLASS} onClick={close}>
              {PUBLISH_COPY.setUp}
            </Link>
          </p>
        ) : (
          <PublishForm
            runId={runId}
            clipId={clipId}
            plan={plan.data}
            onDone={close}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
