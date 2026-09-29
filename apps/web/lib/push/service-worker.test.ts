import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { SERVICE_WORKER_URL } from "./browser-push";

/**
 * `public/sw.js` is plain JavaScript served as it is, so it is run here in a
 * sandbox with a stand-in `self`, the way a browser runs it: what matters is
 * what a push shows and where a click goes — never off this app's origin.
 */

const ORIGIN = "https://app.example.test";
// A plain path join: Vite rewrites a `new URL(template, import.meta.url)` as an asset import.
const WORKER_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
  SERVICE_WORKER_URL.slice(1),
);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- this repository's own public/sw.js, next to this file
const SOURCE = readFileSync(WORKER_FILE, "utf8");

type Handler = (event: Record<string, unknown>) => void;

function worker(windows: { url: string; focus: () => Promise<unknown> }[] = []) {
  const handlers = new Map<string, Handler>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => undefined) },
  };
  runInNewContext(SOURCE, { self, URL });
  const waited: Promise<unknown>[] = [];
  const fire = async (type: string, event: Record<string, unknown>): Promise<void> => {
    handlers.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        waited.push(promise);
      },
    });
    await Promise.all(waited);
  };
  return { self, fire };
}

function push(payload: unknown) {
  return {
    data: {
      json: () => {
        if (typeof payload === "string") throw new SyntaxError("not JSON");
        return payload;
      },
    },
  };
}

describe("the service worker", () => {
  it("shows the API's title and line, one notification per run", async () => {
    const { self, fire } = worker();
    await fire(
      "push",
      push({
        title: "Your clips are ready",
        body: "3 clips from Diwali vlog ready to watch.",
        url: `${ORIGIN}/repurpose/01JRXN0000000000000000000A`,
        tag: "01JRXN0000000000000000000A",
        kind: "clips-ready",
      }),
    );
    expect(self.registration.showNotification).toHaveBeenCalledWith("Your clips are ready", {
      body: "3 clips from Diwali vlog ready to watch.",
      data: { url: `${ORIGIN}/repurpose/01JRXN0000000000000000000A` },
      tag: "01JRXN0000000000000000000A",
      renotify: true,
    });
  });

  it("never points a notification off this app, and survives a payload it cannot read", async () => {
    const { self, fire } = worker();
    await fire("push", push({ title: "Hi", body: "x", url: "https://evil.test/phish" }));
    await fire("push", push("garbage"));
    const calls = self.registration.showNotification.mock.calls as unknown as [
      string,
      { data: { url: string }; tag?: string },
    ][];
    expect(calls[0]?.[1].data.url).toBe(`${ORIGIN}/`);
    expect(calls[1]?.[0]).toBe("New update");
    expect(calls[1]?.[1].tag).toBeUndefined();
  });

  it("opens the run on a click, or brings forward a tab already showing it", async () => {
    const target = `${ORIGIN}/repurpose/01JRXN0000000000000000000A`;
    const close = vi.fn();
    const fresh = worker();
    await fresh.fire("notificationclick", { notification: { close, data: { url: target } } });
    expect(close).toHaveBeenCalled();
    expect(fresh.self.clients.openWindow).toHaveBeenCalledWith(target);

    const focus = vi.fn(async () => undefined);
    const open = worker([{ url: target, focus }]);
    await open.fire("notificationclick", { notification: { close, data: { url: target } } });
    expect(focus).toHaveBeenCalled();
    expect(open.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
