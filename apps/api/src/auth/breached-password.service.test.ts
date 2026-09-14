import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@montaj/config";

import { BreachedPasswordService, countFor } from "./breached-password.service.js";

/** A password with no substring in common with the endpoint's own URL. */
const PASSWORD = "sup3r-secret-passphrase";

function serviceWith(flags: Record<string, unknown>): BreachedPasswordService {
  return new BreachedPasswordService({ FEATURE_FLAGS_JSON: flags } as unknown as Env);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("countFor", () => {
  it("finds the suffix and ignores padding rows", () => {
    const body = "AAAA:0\r\nBBBB:42\r\nCCCC:7";
    expect(countFor(body, "BBBB")).toBe(42);
    expect(countFor(body, "AAAA")).toBe(0);
    expect(countFor(body, "ZZZZ")).toBe(0);
  });

  it("survives a malformed line", () => {
    expect(countFor("garbage\nBBBB:not-a-number", "BBBB")).toBe(0);
  });
});

describe("BreachedPasswordService", () => {
  /**
   * The flag defaults ON (P0-06): an unconfigured environment must still screen
   * compromised passwords, because the one that shipped had `FEATURE_FLAGS_JSON`
   * set to `{}` and therefore no screening at all.
   */
  it("runs when the environment says nothing about the flag", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("AAAA:0\n", { status: 200 }));
    const result = await serviceWith({}).check(PASSWORD);
    expect(result.checked).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing only when the flag is explicitly false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await serviceWith({ "auth.breachedPasswordCheck": false }).check(PASSWORD);
    expect(result).toEqual({ breached: undefined, count: 0, checked: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends only the first five hex characters of the SHA-1", async () => {
    // sha1(PASSWORD) = 1620E429683873CDF6AC4187B646AC5F64015374
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("429683873CDF6AC4187B646AC5F64015374:12345\n", { status: 200 }),
      );

    const result = await serviceWith({ "auth.breachedPasswordCheck": true }).check(PASSWORD);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.pwnedpasswords.com/range/1620E");
    // Neither the password nor the rest of its digest ever leaves the process.
    expect(String(url)).not.toContain(PASSWORD);
    expect(String(url)).not.toContain("429683873CDF");
    expect(JSON.stringify(init)).not.toContain(PASSWORD);
    expect(result).toEqual({ breached: true, count: 12345, checked: true });
  });

  it("reports a clean password", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("FFFF:0\n", { status: 200 }));
    const result = await serviceWith({ "auth.breachedPasswordCheck": true }).check(PASSWORD);
    expect(result).toEqual({ breached: false, count: 0, checked: true });
  });

  it("fails open when the provider errors or times out", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
    const timedOut = await serviceWith({ "auth.breachedPasswordCheck": true }).check(PASSWORD);
    expect(timedOut).toEqual({ breached: undefined, count: 0, checked: false });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const unavailable = await serviceWith({ "auth.breachedPasswordCheck": true }).check(PASSWORD);
    expect(unavailable).toEqual({ breached: undefined, count: 0, checked: false });
  });
});
