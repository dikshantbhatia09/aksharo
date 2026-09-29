import { describe, expect, it, vi } from "vitest";

import { WatchNotifier } from "./watch-notices.js";
import { isDeviceKind, isInAppKind } from "../../notify/notify.kinds.js";
import { renderDeviceText, renderNotification } from "../../notify/templates/render.js";

const WS = "01JWS00000000000000000000A";
const USER = "01JUSER0000000000000000000";
const OWNER = "01JOWNER000000000000000000";
const WATCH = {
  id: "01JWATCH000000000000000000",
  workspaceId: WS,
  createdBy: USER,
  title: "Asha Cooks",
};

function notifier(options: { creator?: boolean; owner?: boolean } = {}) {
  const enqueue = vi.fn(async () => ({}));
  const prisma = {
    user: {
      findFirst: vi.fn(async () =>
        options.creator === false
          ? null
          : { id: USER, email: "asha@example.test", name: "Asha", locale: "hi" },
      ),
    },
    workspace: {
      findFirst: vi.fn(async () =>
        options.owner === false
          ? null
          : {
              owner: {
                id: OWNER,
                email: "owner@example.test",
                name: null,
                locale: "en",
                deletedAt: null,
              },
            },
      ),
    },
  };
  const service = new WatchNotifier(
    prisma as never,
    { enqueue } as never,
    {
      WEB_ORIGIN: "https://app.example.test",
    } as never,
  );
  return { service, enqueue };
}

describe("WatchNotifier", () => {
  it("tells the person a new episode is being made into clips, once per run", async () => {
    const { service, enqueue } = notifier();
    await service.newVideo(WATCH, {
      title: "Diwali sweets, part 2",
      runId: "01JRUN0000000000000000000A",
    });
    expect(enqueue).toHaveBeenCalledWith({
      kind: "watch-new-video",
      to: "asha@example.test",
      locale: "hi",
      userId: USER,
      workspaceId: WS,
      data: {
        channel: "Asha Cooks",
        video: "Diwali sweets, part 2",
        runId: "01JRUN0000000000000000000A",
        link: "https://app.example.test/repurpose/01JRUN0000000000000000000A",
        name: "Asha",
      },
      idempotencyKey: "watch-new-video:01JRUN0000000000000000000A",
      thread: "01JRUN0000000000000000000A",
    });
  });

  it("tells whoever is left - the owner - when the person who connected it has gone", async () => {
    const { service, enqueue } = notifier({ creator: false });
    await service.paused(WATCH, "no_credits", new Date(1_000));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "watch-paused",
        to: "owner@example.test",
        idempotencyKey: `watch-paused:${WATCH.id}:1000`,
        data: {
          channel: "Asha Cooks",
          reason: "credits",
          link: "https://app.example.test/repurpose/automations",
        },
      }),
    );
  });

  it("says nothing about a person's own pause or a creator leaving, and never throws", async () => {
    const { service, enqueue } = notifier();
    await service.paused(WATCH, "person", new Date());
    await service.paused(WATCH, "creator_left", new Date());
    expect(enqueue).not.toHaveBeenCalled();

    const broken = notifier({ creator: false, owner: false });
    await expect(broken.service.paused(WATCH, "no_credits", new Date())).resolves.toBeUndefined();
    expect(broken.enqueue).not.toHaveBeenCalled();
    enqueue.mockRejectedValueOnce(new Error("queue down"));
    await expect(
      service.newVideo(WATCH, { title: "x", runId: "01JRUN0000000000000000000A" }),
    ).resolves.toBeUndefined();
  });

  it("renders in both languages, with a device line only for a pause", () => {
    expect(isInAppKind("watch-new-video")).toBe(true);
    expect(isDeviceKind("watch-new-video")).toBe(false);
    expect(isDeviceKind("watch-paused")).toBe(true);
    for (const locale of ["en", "hi"]) {
      const rendered = renderNotification({
        kind: "watch-new-video",
        locale,
        data: { channel: "Asha Cooks", link: "https://app.example.test/repurpose/r" },
      });
      expect(rendered.subject).toContain("Asha Cooks");
      for (const reason of ["credits", "style", "setup", "channel"]) {
        const text = renderDeviceText({
          kind: "watch-paused",
          locale,
          data: { channel: "Asha Cooks", reason },
        });
        expect(text?.body, `${locale} ${reason}`).toContain("Asha Cooks");
      }
    }
    // No title known: each language's own "your video".
    expect(
      renderNotification({
        kind: "watch-new-video",
        locale: "en",
        data: { channel: "Asha Cooks", link: "https://app.example.test/x" },
      }).text,
    ).toContain("your video");
  });
});
