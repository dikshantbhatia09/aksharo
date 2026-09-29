import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { NotificationBell } from "./notification-bell";
import { notificationHref, notificationText, relativeTime } from "./notification-copy";

import { LocaleProvider } from "@/lib/i18n/locale-provider";
import { renderWithProviders } from "@/test/harness";
import { routerMock } from "@/test/next-router";

// A real ULID: Crockford base32 has no I, L, O or U, and the bell checks it.
const RUN = "01JRXN0000000000000000000A";
const ORIGIN = "https://app.example.test";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01JNOTE000000000000000000A",
    kind: "clips-ready",
    workspaceId: "01JWORKSPACE",
    data: { video: "Diwali vlog", count: 3, runId: RUN, link: `${ORIGIN}/repurpose/${RUN}` },
    readAt: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const english = (key: string, values?: Record<string, string | number>): string =>
  `${key}${values === undefined ? "" : JSON.stringify(values)}`;

describe("notification copy", () => {
  it("opens a run's notification on its run, from a checked id and never a raw URL", () => {
    expect(notificationHref({ kind: "run-failed", data: { runId: RUN } }, ORIGIN)).toBe(
      `/repurpose/${RUN}`,
    );
    // Not a run id: the path is not built from it.
    expect(
      notificationHref({ kind: "run-failed", data: { runId: "../../admin" } }, ORIGIN),
    ).toBeNull();
    // Another site's link is not followed from the bell.
    expect(
      notificationHref({ kind: "export-ready", data: { link: "https://evil.test/x" } }, ORIGIN),
    ).toBeNull();
    expect(
      notificationHref(
        { kind: "export-ready", data: { link: `${ORIGIN}/exports/01J?x=1` } },
        ORIGIN,
      ),
    ).toBe("/exports/01J?x=1");
  });

  it("still reads as something when a row is missing its numbers or its kind is unknown", () => {
    expect(notificationText({ kind: "clips-ready", data: null }, english, ORIGIN).body).toBe(
      'notifications.clipsReady.body{"count":1,"video":"notifications.video"}',
    );
    expect(
      notificationText({ kind: "run-needs-you", data: { reason: "credits" } }, english, ORIGIN),
    ).toMatchObject({ title: 'notifications.needsYou.title{"reason":"credits"}', tone: "yours" });
    expect(notificationText({ kind: "something-new", data: {} }, english, ORIGIN)).toMatchObject({
      title: "notifications.other.title",
      tone: "neutral",
      href: null,
    });
  });

  it("says when, in the person's words", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    expect(relativeTime("2026-09-29T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-09-28T12:00:00Z", "en", now)).toBe("yesterday");
    expect(relativeTime("not a date", "en", now)).toBe("");
  });
});

describe("<NotificationBell />", () => {
  beforeEach(() => {
    routerMock.push.mockClear();
  });

  it("shows a dot while anything is unread, and says how many", async () => {
    renderWithProviders(<NotificationBell />, {
      routes: { "/me/notifications": { items: [row()], nextCursor: null, unread: 2 } },
    });
    expect(await screen.findByTestId("notification-unread-dot")).toBeInTheDocument();
    expect(screen.getByTestId("notification-bell")).toHaveAccessibleName("Notifications, 2 unread");
  });

  it("lists each kind in plain words, and opening one marks it read and goes to its run", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<NotificationBell />, {
      routes: {
        "/me/notifications": {
          items: [
            row(),
            row({
              id: "01JNOTE000000000000000000B",
              kind: "run-needs-you",
              data: { video: "Diwali vlog", reason: "upload", runId: RUN },
              readAt: "2026-09-29T11:00:00.000Z",
            }),
          ],
          nextCursor: null,
          unread: 1,
        },
        [`/me/notifications/01JNOTE000000000000000000A/read`]: row({
          readAt: new Date().toISOString(),
        }),
      },
    });
    await screen.findByTestId("notification-unread-dot");
    await user.click(screen.getByTestId("notification-bell"));

    const first = await screen.findByTestId("notification-01JNOTE000000000000000000A");
    expect(first).toHaveTextContent("Your clips are ready");
    expect(first).toHaveTextContent("3 clips from Diwali vlog ready to watch.");
    expect(first).toHaveAttribute("data-unread", "true");
    const second = screen.getByTestId("notification-01JNOTE000000000000000000B");
    expect(second).toHaveTextContent("Upload the file instead");
    expect(second).toHaveTextContent(
      "YouTube keeps refusing Diwali vlog. Upload it from your device.",
    );
    expect(second).toHaveAttribute("data-unread", "false");

    await user.click(first);
    expect(routerMock.push).toHaveBeenCalledWith(`/repurpose/${RUN}`);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith(`/me/notifications/01JNOTE000000000000000000A/read`),
        ),
      ).toBe(true);
    });
  });

  it("speaks Hindi to a Hindi profile", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LocaleProvider profileLocale="hi-IN">
        <NotificationBell />
      </LocaleProvider>,
      {
        routes: {
          "/me/notifications": {
            items: [row({ kind: "run-failed", data: { runId: RUN } })],
            nextCursor: null,
            unread: 1,
          },
        },
      },
    );
    await screen.findByTestId("notification-unread-dot");
    await user.click(screen.getByTestId("notification-bell"));
    const item = await screen.findByTestId("notification-01JNOTE000000000000000000A");
    expect(within(item).getByText("एक वीडियो रुक गया")).toBeInTheDocument();
    expect(item).toHaveTextContent("हम आपका वीडियो पूरा नहीं कर पाए।");
  });

  it("says there is nothing yet, rather than an empty box", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotificationBell />, {
      routes: { "/me/notifications": { items: [], nextCursor: null, unread: 0 } },
    });
    await user.click(await screen.findByTestId("notification-bell"));
    expect(await screen.findByTestId("notification-empty")).toHaveTextContent(
      "We will tell you here when your clips are ready.",
    );
    expect(screen.queryByTestId("notification-unread-dot")).toBeNull();
  });
});
