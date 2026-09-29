/**
 * What one bell row says, and where opening it goes (2026-09-29).
 *
 * The API stores no wording on a notification (`NotificationDto.kind`: "the
 * client renders its own wording per locale"), only the variables its email
 * used. So each kind's sentence lives here, in both catalogues
 * (`messages/en.json`, `messages/hi.json`), written from those variables — the
 * same words the lock-screen notification used (`notify/templates`, `push`).
 *
 * A row from before a variable existed, or of a kind this build does not know,
 * still reads as something: every value has a stand-in, and an unknown kind is
 * "An update".
 */
import type { NotificationItem } from "@montaj/api-client";

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** How a row is marked beside its text: good news, a stop, or the person's turn. */
export type NotificationTone = "done" | "stopped" | "yours" | "neutral";

export interface NotificationText {
  readonly title: string;
  readonly body: string;
  /** A path on this app, or null when the row has nowhere to open. */
  readonly href: string | null;
  readonly tone: NotificationTone;
}

const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function text(data: Record<string, unknown>, key: string): string | undefined {
  // eslint-disable-next-line security/detect-object-injection -- `key` is one of this file's literals
  const value = data[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function count(data: Record<string, unknown>, key: string): number {
  // eslint-disable-next-line security/detect-object-injection -- as above
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 1;
}

/**
 * Where a row opens. A run's own page for the clips kinds (from its id, which
 * is checked, never a URL taken on trust); otherwise the email's link, but only
 * its path and only when it points at this app.
 */
export function notificationHref(
  item: Pick<NotificationItem, "kind" | "data">,
  origin: string,
): string | null {
  const data = item.data ?? {};
  const runId = text(data, "runId");
  if (runId !== undefined && RUN_ID.test(runId)) return `/repurpose/${runId}`;
  const link = text(data, "link");
  if (link === undefined) return null;
  try {
    const url = new URL(link, origin);
    return url.origin === new URL(origin).origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

export function notificationText(
  item: Pick<NotificationItem, "kind" | "data">,
  t: Translate,
  origin: string,
): NotificationText {
  const data = item.data ?? {};
  const video = text(data, "video") ?? t("notifications.video");
  const href = notificationHref(item, origin);
  switch (item.kind) {
    case "clips-ready":
      return {
        title: t("notifications.clipsReady.title"),
        body: t("notifications.clipsReady.body", { count: count(data, "count"), video }),
        href,
        tone: "done",
      };
    case "run-complete":
      return {
        title: t("notifications.runComplete.title"),
        body: t("notifications.runComplete.body", { count: count(data, "count"), video }),
        href,
        tone: "done",
      };
    case "run-failed":
      return {
        title: t("notifications.runFailed.title"),
        body: t("notifications.runFailed.body", { video }),
        href,
        tone: "stopped",
      };
    case "run-needs-you": {
      const reason = text(data, "reason") ?? "moments";
      return {
        title: t("notifications.needsYou.title", { reason }),
        body: t("notifications.needsYou.body", { reason, video }),
        href,
        tone: "yours",
      };
    }
    case "watch-new-video":
      return {
        title: t("notifications.watchNewVideo.title"),
        body: t("notifications.watchNewVideo.body", {
          channel: text(data, "channel") ?? t("notifications.channel"),
          video,
        }),
        href,
        tone: "done",
      };
    case "watch-paused": {
      const reason = text(data, "reason") ?? "other";
      return {
        title: t("notifications.watchPaused.title", { reason }),
        body: t("notifications.watchPaused.body", {
          reason,
          channel: text(data, "channel") ?? t("notifications.channel"),
        }),
        href,
        tone: "yours",
      };
    }
    case "clip-review": {
      // 2026-10-03: a clip approved, sent back for changes, commented on, or
      // back in review because its video changed.
      const verdict = text(data, "verdict") ?? "comment";
      const by = text(data, "by") ?? "member";
      const values = {
        verdict,
        by,
        who: text(data, "who") ?? t("notifications.someone"),
        clip: text(data, "clip") ?? t("notifications.clip"),
      };
      return {
        title: t("notifications.clipReview.title", values),
        body: t("notifications.clipReview.body", values),
        href,
        tone:
          verdict === "approved"
            ? "done"
            : verdict === "changes" || verdict === "reopened"
              ? "yours"
              : "neutral",
      };
    }
    case "export-ready":
      return {
        title: t("notifications.exportReady.title"),
        body: t("notifications.exportReady.body", {
          project: text(data, "project") ?? t("notifications.video"),
        }),
        href,
        tone: "done",
      };
    case "low-credits":
      return {
        title: t("notifications.lowCredits.title"),
        body: t("notifications.lowCredits.body", { minutes: count(data, "minutes") }),
        href,
        tone: "yours",
      };
    default:
      return {
        title: t("notifications.other.title"),
        body: t("notifications.other.body"),
        href,
        tone: "neutral",
      };
  }
}

/** "5 minutes ago", "कल", in the person's language; never a timestamp to decode. */
export function relativeTime(iso: string, locale: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}
