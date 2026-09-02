import { describe, expect, it, vi } from "vitest";

import { type ApiClient, createApiClient } from "@montaj/api-client";
import { signedFixtureManifest } from "@montaj/render-manifest/testing";

import { exportEndpoints } from "./endpoints";
import { completeExportManifest, requestExportManifest, sanityCheckManifest } from "./manifest";

const SECRET = "test-secret";

function clientWithFetch(fetchImpl: typeof fetch): ApiClient {
  return createApiClient({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("requestExportManifest", () => {
  it("returns the parsed manifest on the browser path", async () => {
    const manifest = signedFixtureManifest(SECRET);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            exportId: manifest.exportId,
            path: "browser",
            reasons: [],
            watermarked: false,
            quote: { tenths: 0, credits: "0" },
            manifest,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const result = await requestExportManifest(client, "01JA20PRJECT00000000000000", {});
    expect(result.manifest).not.toBeNull();
    expect(result.manifest?.manifestId).toBe(manifest.manifestId);
  });

  it("returns null manifest on the cloud path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            exportId: "01JA20EXPRT000000000000000",
            path: "cloud",
            reasons: ["Cloud render — 0.5 credits per output minute"],
            watermarked: false,
            quote: { tenths: 5, credits: "0.5" },
            job: { jobId: "01JJOB0000000000000000000", status: "queued", deduplicated: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const result = await requestExportManifest(client, "01JA20PRJECT00000000000000", {});
    expect(result.manifest).toBeNull();
    expect(result.response.path).toBe("cloud");
  });

  it("throws when the API returns a manifest that fails the v1 schema", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            exportId: "01JA20EXPRT000000000000000",
            path: "browser",
            reasons: [],
            watermarked: false,
            quote: { tenths: 0, credits: "0" },
            manifest: { v: 1, not: "a manifest" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    await expect(
      requestExportManifest(client, "01JA20PRJECT00000000000000", {}),
    ).rejects.toMatchObject({
      code: "manifest/malformed",
    });
  });
});

describe("sanityCheckManifest", () => {
  const manifest = signedFixtureManifest(SECRET, undefined, Date.parse("2026-09-02T09:00:00.000Z"));

  it("is ok within the clock window and caps", () => {
    const result = sanityCheckManifest(manifest, 10_000, Date.parse("2026-09-02T09:00:30.000Z"));
    expect(result.ok).toBe(true);
  });

  it("flags an expired manifest", () => {
    const result = sanityCheckManifest(manifest, 10_000, Date.parse("2026-09-02T12:00:00.000Z"));
    expect(result.ok).toBe(false);
    expect(result.expired).toBe(true);
  });

  it("flags a cap violation on the rendered duration", () => {
    const result = sanityCheckManifest(
      manifest,
      10_000_000_000,
      Date.parse("2026-09-02T09:00:30.000Z"),
    );
    expect(result.ok).toBe(false);
    expect(result.capViolations.length).toBeGreaterThan(0);
  });
});

describe("completeExportManifest", () => {
  it("posts to /exports/manifests/{id}/complete", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/exports/manifests/abc/complete");
      return new Response(
        JSON.stringify({
          exportId: "01JA20EXPRT000000000000000",
          status: "succeeded",
          downloadAvailable: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const result = await completeExportManifest(client, "abc", {
      sizeBytes: 100,
      durationMs: 5000,
      checksum: "deadbeef",
    });
    expect(result.status).toBe("succeeded");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

it("exportEndpoints.create posts to /projects/{id}/exports", () => {
  expect(exportEndpoints.create.method).toBe("POST");
  expect(exportEndpoints.create.path).toBe("/projects/{projectId}/exports");
});
