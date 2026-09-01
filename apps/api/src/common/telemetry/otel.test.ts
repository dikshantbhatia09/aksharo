import { describe, expect, it } from "vitest";

import { resolveOtlpEndpoint, shutdownTelemetry, startTelemetry } from "./otel.js";

describe("resolveOtlpEndpoint", () => {
  it("is undefined when nothing is configured", () => {
    expect(resolveOtlpEndpoint({})).toBeUndefined();
    expect(resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBeUndefined();
  });

  it("appends the traces path to the general endpoint", () => {
    expect(resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(
      "http://collector:4318/v1/traces",
    );
  });

  it("does not double the slash on a trailing-slash endpoint", () => {
    expect(resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })).toBe(
      "http://collector:4318/v1/traces",
    );
  });

  it("prefers the traces-specific endpoint", () => {
    expect(
      resolveOtlpEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://general:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:4318/v1/traces",
      }),
    ).toBe("http://traces:4318/v1/traces");
  });
});

describe("startTelemetry", () => {
  it("is a no-op when no endpoint is configured", async () => {
    const stop = await startTelemetry({ env: {} });
    // Resolves without having loaded the SDK at all.
    await expect(stop()).resolves.toBeUndefined();
  });

  it("shutdownTelemetry is safe to call when nothing was started", async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
