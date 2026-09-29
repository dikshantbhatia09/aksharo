import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationsView } from "./notifications-view";

import { keyBytes } from "@/lib/push/browser-push";
import { renderWithProviders } from "@/test/harness";

/** A real-looking VAPID public key: 65 bytes, uncompressed point marker first. */
const PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const OTHER_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString("base64url");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function subscription(key: string = PUBLIC_KEY): FakeSubscription {
  return {
    endpoint: ENDPOINT,
    options: { applicationServerKey: keyBytes(key).buffer },
    toJSON: () => ({
      endpoint: ENDPOINT,
      expirationTime: null,
      keys: { p256dh: "BPUBLICKEY", auth: "AUTHSECRET" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** A browser with service workers, push and notifications, as far as the page uses them. */
function browser(
  options: { permission?: NotificationPermission; existing?: FakeSubscription | null } = {},
) {
  let current: FakeSubscription | null = options.existing ?? null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(
      async (init: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        current = {
          ...subscription(),
          options: { applicationServerKey: init.applicationServerKey.buffer as ArrayBuffer },
        };
        return current;
      },
    ),
  };
  const registration = { pushManager };
  const serviceWorker = {
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(async () => (current === null ? undefined : registration)),
  };
  const requestPermission = vi.fn(async (): Promise<NotificationPermission> => "granted");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: function PushManager() {},
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission: options.permission ?? "default", requestPermission },
  });
  return { serviceWorker, pushManager, requestPermission };
}

function withoutPush(): void {
  // jsdom has none of the three; make sure a previous test's fakes are gone.
  for (const [target, name] of [
    [navigator, "serviceWorker"],
    [window, "PushManager"],
    [window, "Notification"],
  ] as const) {
    if (name in target) Reflect.deleteProperty(target, name);
  }
}

beforeEach(withoutPush);
afterEach(withoutPush);

describe("Settings > Notifications: this device", () => {
  it("asks the browser nothing until the switch is used, then turns notifications on", async () => {
    const user = userEvent.setup();
    const fake = browser();
    const { fetchMock } = renderWithProviders(<NotificationsView />, {
      routes: {
        "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY },
        "/me/push-subscriptions": { id: "01JSUB", createdAt: "2026-09-29T12:00:00.000Z" },
      },
    });
    const toggle = await screen.findByTestId("settings-push-device");
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(fake.requestPermission).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
    expect(fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(fake.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    const init = fake.pushManager.subscribe.mock.calls[0]?.[0];
    expect(init?.userVisibleOnly).toBe(true);
    expect(Array.from(init?.applicationServerKey ?? [])).toEqual(Array.from(keyBytes(PUBLIC_KEY)));
    const post = fetchMock.mock.calls.find(
      ([input, request]) =>
        String(input).endsWith("/me/push-subscriptions") &&
        (request as RequestInit).method === "POST",
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      endpoint: ENDPOINT,
      expirationTime: null,
      keys: { p256dh: "BPUBLICKEY", auth: "AUTHSECRET" },
    });
  });

  it("turns them off: the server forgets this browser, and the browser unsubscribes", async () => {
    const user = userEvent.setup();
    const existing = subscription();
    browser({ permission: "granted", existing });
    const { fetchMock } = renderWithProviders(<NotificationsView />, {
      routes: {
        "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY },
        "/me/push-subscriptions": new Response(null, { status: 204 }),
      },
    });
    const toggle = await screen.findByTestId("settings-push-device");
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "false");
    });
    const deleted = fetchMock.mock.calls.find(
      ([, request]) => (request as RequestInit).method === "DELETE",
    );
    expect(JSON.parse(String((deleted?.[1] as RequestInit).body))).toEqual({ endpoint: ENDPOINT });
    expect(existing.unsubscribe).toHaveBeenCalled();
  });

  it("drops a subscription made with a key this server no longer uses", async () => {
    const stale = subscription(OTHER_KEY);
    browser({ permission: "granted", existing: stale });
    renderWithProviders(<NotificationsView />, {
      routes: { "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY } },
    });
    await waitFor(() => {
      expect(stale.unsubscribe).toHaveBeenCalled();
    });
    expect(screen.getByTestId("settings-push-device")).toHaveAttribute("aria-checked", "false");
  });

  it("says why it cannot be turned on: blocked, not offered here, or not possible in this browser", async () => {
    browser({ permission: "denied" });
    const blocked = renderWithProviders(<NotificationsView />, {
      routes: { "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY } },
    });
    expect(await screen.findByTestId("push-device-note")).toHaveTextContent(
      /blocked for this site/,
    );
    expect(screen.getByTestId("settings-push-device")).toBeDisabled();
    blocked.unmount();

    browser();
    const off = renderWithProviders(<NotificationsView />, {
      routes: { "/me/push-subscriptions/key": { publicKey: null } },
    });
    expect(await screen.findByTestId("push-device-note")).toHaveTextContent(/not switched on/);
    off.unmount();

    withoutPush();
    renderWithProviders(<NotificationsView />, {
      routes: { "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY } },
    });
    expect(await screen.findByTestId("push-device-note")).toHaveTextContent(
      /cannot show notifications/,
    );
  });

  it("stays off, and says so, when the person does not allow it", async () => {
    const user = userEvent.setup();
    const fake = browser();
    fake.requestPermission.mockResolvedValueOnce("denied");
    renderWithProviders(<NotificationsView />, {
      routes: { "/me/push-subscriptions/key": { publicKey: PUBLIC_KEY } },
    });
    const toggle = await screen.findByTestId("settings-push-device");
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    await user.click(toggle);
    expect(await screen.findByTestId("push-device-note")).toHaveTextContent(/blocked/);
    expect(fake.pushManager.subscribe).not.toHaveBeenCalled();
  });
});
