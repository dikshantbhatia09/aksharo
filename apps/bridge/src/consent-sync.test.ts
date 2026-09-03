import { describe, expect, it, vi } from "vitest";

import { fetchTelemetryConsent, startConsentPolling } from "./consent-sync.js";

function fakeConsentsFetch(purposes: readonly { purpose: string; granted: boolean }[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ purposes }),
  });
}

describe("fetchTelemetryConsent", () => {
  it("reads the telemetry purpose's granted flag with the device token", async () => {
    const fetchImpl = fakeConsentsFetch([
      { purpose: "analytics", granted: false },
      { purpose: "telemetry", granted: true },
    ]);
    const granted = await fetchTelemetryConsent({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(granted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.aksharo.test/consents",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer dev-token" }),
      }),
    );
  });

  it("treats a purpose absent from the response as not granted", async () => {
    const fetchImpl = fakeConsentsFetch([{ purpose: "analytics", granted: true }]);
    const granted = await fetchTelemetryConsent({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(granted).toBe(false);
  });

  it("returns undefined (not false) on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const granted = await fetchTelemetryConsent({
      apiOrigin: "https://api.aksharo.test",
      deviceToken: "dev-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(granted).toBeUndefined();
  });

  it("returns undefined (never throws) when fetch itself rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      fetchTelemetryConsent({
        apiOrigin: "https://api.aksharo.test",
        deviceToken: "dev-token",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("startConsentPolling", () => {
  it("calls onChange when a poll's answer differs from the last known one", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fakeConsentsFetch([{ purpose: "telemetry", granted: true }]);
      const onChange = vi.fn();
      const handle = startConsentPolling({
        apiOrigin: "https://api.aksharo.test",
        deviceToken: "dev-token",
        intervalMs: 1000,
        onChange,
        initialKnown: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledWith(true);
      expect(onChange).toHaveBeenCalledTimes(1);

      // A second poll confirming the same answer does not re-fire.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(1);

      handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call onChange when a poll fails", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
      const onChange = vi.fn();
      const handle = startConsentPolling({
        apiOrigin: "https://api.aksharo.test",
        deviceToken: "dev-token",
        intervalMs: 1000,
        onChange,
        initialKnown: false,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
