import { afterEach, describe, expect, it, vi } from "vitest";

import { AlertSender, alertTarget } from "./alert.js";
import { logger } from "./logger.js";

import type { Alert } from "./alert.js";

/** ntfy, as far as the sender sees it: whatever `status` says, and every call kept. */
function ntfy(status = 200): ReturnType<typeof vi.fn> & typeof globalThis.fetch {
  return vi.fn(async () => new Response("{}", { status })) as unknown as ReturnType<
    typeof vi.fn
  > &
    typeof globalThis.fetch;
}

const ALERT: Alert = {
  title: "Aksharo: worker-media refused to start",
  body: "media.acquire: yt-dlp-ejs is not installed",
  priority: "urgent",
  tags: ["rotating_light"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alertTarget", () => {
  it("takes an https URL, or http to this machine", () => {
    expect(alertTarget(" https://ntfy.sh/aksharo-ops-x1 ")).toBeInstanceOf(URL);
    expect(alertTarget("http://127.0.0.1:8090/ops")).toBeInstanceOf(URL);
    expect(alertTarget("http://localhost/ops")).toBeInstanceOf(URL);
  });

  it("has nothing to send to when unset, and ignores anything else rather than refusing to start", () => {
    expect(alertTarget(undefined)).toBeNull();
    expect(alertTarget("   ")).toBeNull();
    for (const value of ["http://ntfy.sh/ops", "https://u:p@ntfy.sh/ops", "ntfy.sh/ops", "ftp://ntfy.sh/x"]) {
      expect(alertTarget(value), value).toBe("invalid");
    }
  });
});

describe("AlertSender", () => {
  it("posts the body as plain text, with ntfy's Title, Priority and Tags headers", async () => {
    const fetchImpl = ntfy();
    await expect(
      new AlertSender(new URL("https://ntfy.sh/aksharo-ops"), fetchImpl).send(ALERT),
    ).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://ntfy.sh/aksharo-ops");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(ALERT.body);
    expect(init.headers).toMatchObject({
      Title: ALERT.title,
      Priority: "urgent",
      Tags: "rotating_light",
    });
  });

  it("keeps a header to printable ASCII, which is all HTTP carries", async () => {
    const fetchImpl = ntfy();
    await new AlertSender(new URL("https://ntfy.sh/x"), fetchImpl).send({
      ...ALERT,
      title: "worker-media — 5 GiB “floor”",
    });
    const init = (fetchImpl.mock.calls[0] as [URL, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Title"]).toBe("worker-media ? 5 GiB ?floor?");
  });

  it("never throws: a refused or failed alert is logged, and the work goes on", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(new AlertSender(new URL("https://ntfy.sh/x"), ntfy(500)).send(ALERT)).resolves.toBe(
      false,
    );
    const broken = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND ntfy.sh");
    }) as unknown as typeof globalThis.fetch;
    await expect(new AlertSender(new URL("https://ntfy.sh/x"), broken).send(ALERT)).resolves.toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("writes the alert to the log when there is nowhere to send it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const fetchImpl = ntfy();
    const sender = AlertSender.fromSetting("http://ntfy.sh/ops", fetchImpl);
    await expect(sender.send(ALERT)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Once for the unusable URL, once for the alert itself. The URL never.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ntfy.sh/ops");
  });

  it("sends a lasting condition once per interval, not once per minute", async () => {
    const fetchImpl = ntfy();
    const sender = new AlertSender(new URL("https://ntfy.sh/x"), fetchImpl);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await sender.sendAtMostEvery("disk", 3_600_000, ALERT);
    now.mockReturnValue(1_000_000 + 3_599_999);
    await sender.sendAtMostEvery("disk", 3_600_000, ALERT);
    // Another condition is its own.
    await sender.sendAtMostEvery("other", 3_600_000, ALERT);
    now.mockReturnValue(1_000_000 + 3_600_000);
    await sender.sendAtMostEvery("disk", 3_600_000, ALERT);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
