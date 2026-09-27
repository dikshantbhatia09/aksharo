import { describe, expect, it, vi } from "vitest";

import { AlertSender, scrub } from "./alert-sender.js";

import type { OpsAlert } from "./alert-sender.js";

const ALERT: OpsAlert = {
  title: "Aksharo ops: disk space low",
  body: "new: C:\\ 3.2 GiB free of 476.0 GiB (0.7%)",
  priority: 5,
  tags: ["floppy_disk", "disk.low"],
};

function webhookSender(fetch: ReturnType<typeof vi.fn>) {
  return new AlertSender({
    setting: { kind: "ok", url: new URL("https://ntfy.sh/aksharo-ops-secret-topic") },
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

describe("AlertSender with ALERT_WEBHOOK_URL", () => {
  it("posts ntfy's publish format: text body, Title, Priority and Tags headers", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(webhookSender(fetch).send(ALERT)).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://ntfy.sh/aksharo-ops-secret-topic");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(ALERT.body);
    expect(init.headers).toMatchObject({
      "Content-Type": "text/plain; charset=utf-8",
      Title: "Aksharo ops: disk space low",
      Priority: "5",
      Tags: "floppy_disk,disk.low",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a refused or unreachable webhook as not delivered, without throwing", async () => {
    const refused = vi.fn(async () => new Response("too many", { status: 429 }));
    await expect(webhookSender(refused).send(ALERT)).resolves.toBe(false);

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(webhookSender(down).send(ALERT)).resolves.toBe(false);
  });

  it("scrubs URLs and tokens, and keeps headers to printable ASCII", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));

    await webhookSender(fetch).send({
      ...ALERT,
      title: "clips — run failed\r\nX-Injected: 1",
      // Any 40+ character token-like run, built here so no key-shaped literal
      // sits in the source (push protection reads test files too).
      body: `see https://aksharo-media.example/raw/a.mp4?X-Amz-Signature=abc and key ${"Ab3_".repeat(11)}`,
    });

    const init = (fetch.mock.calls[0] as unknown as [URL, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Title"]).toBe("clips ? run failed??X-Injected: 1");
    expect(init.body).toBe("see [url] and key [redacted]");
  });

  it("says where alerts go", () => {
    expect(webhookSender(vi.fn()).destination).toBe("webhook");
  });
});

describe("AlertSender without a usable ALERT_WEBHOOK_URL", () => {
  it("writes the alert to the log and counts it delivered, sending nothing", async () => {
    const fetch = vi.fn();
    const sender = new AlertSender({
      setting: { kind: "unset" },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const warn = vi.spyOn(
      (sender as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
      "warn",
    );

    await expect(sender.send(ALERT)).resolves.toBe(true);

    expect(fetch).not.toHaveBeenCalled();
    expect(sender.destination).toBe("log");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ title: ALERT.title, body: ALERT.body }),
      "ops alert",
    );
  });

  it("treats an invalid value as log only", async () => {
    const fetch = vi.fn();
    const sender = new AlertSender({
      setting: { kind: "invalid", problem: "insecure" },
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(sender.send(ALERT)).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("scrub", () => {
  it("leaves ids, codes, queue names and durations alone", () => {
    const line = "media.proxy 01M3GT41HE3SR3SS7AXY54K05A: running 2 h 10 min (media/probe_failed)";
    expect(scrub(line)).toBe(line);
  });
});
