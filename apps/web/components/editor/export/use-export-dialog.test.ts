import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useExportDialog } from "./use-export-dialog";

import type { ExportDialogDeps } from "./use-export-dialog";

/**
 * `useExportDialog` reaching the real engine at all needs a probe, a manifest
 * request and an audio-strategy decision to each say "keep going" — none of
 * that is what this file is testing, so every collaborator up to `runExport`
 * itself is mocked to the minimum that clears those checks. What IS under
 * test is a single wire: whatever `preferFileSystemAccess` resolves to must be
 * exactly what reaches `runExport`, given the deps default, an explicit
 * override, the E2E window flag (armed only on a loopback origin — this
 * repo's e2e suite production-builds the app, so `NODE_ENV` cannot be the
 * gate; see `use-export-dialog.ts`'s comment on `e2eNoFilePicker`), and a
 * real (non-loopback) origin suppressing that flag (A07b).
 */

const runExport = vi.fn(async (_options: unknown) => ({
  sizeBytes: 1_024,
  durationMs: 1_000,
  checksum: "abc",
}));

vi.mock("@/lib/export/engine", () => ({ runExport: (options: unknown) => runExport(options) }));

vi.mock("@montaj/api-client", () => ({ useApiClient: () => ({}) }));

vi.mock("@/lib/export", () => ({
  probeExportCapabilities: async () => ({ audio: { aac: true } }),
  isBrowserExportEligible: () => true,
  toCapabilitiesRequest: () => ({}),
  requestExportManifest: async () => ({
    response: { sources: { rawUrl: "blob:raw-source" } },
    manifest: { manifestId: "m1", exportId: "e1", output: { width: 1080, height: 1920 } },
  }),
  outputDurationMsFor: () => 1_000,
  sanityCheckManifest: () => ({ ok: true }),
  decideAudioStrategy: () => ({ kind: "no-audio" }),
  completeExportManifest: async () => ({}),
}));

function deps(overrides: Partial<ExportDialogDeps> = {}): ExportDialogDeps {
  return {
    projectId: "01JCPR0JECT000000000000000",
    projection: {} as ExportDialogDeps["projection"],
    catalogue: new Map(),
    registry: {} as ExportDialogDeps["registry"],
    shaper: {} as ExportDialogDeps["shaper"],
    ...overrides,
  };
}

async function runStartExport(d: ExportDialogDeps): Promise<void> {
  const { result } = renderHook(() => useExportDialog(d));
  await act(async () => {
    await result.current.startExport({});
  });
}

interface E2EWindow {
  __aksharoE2E?: { noFilePicker?: boolean };
}

function setE2EFlag(noFilePicker: boolean): void {
  (window as unknown as E2EWindow).__aksharoE2E = { noFilePicker };
}

/**
 * jsdom's default test origin is `http://localhost:3000/` — a loopback host.
 * `window.location` is not writable by simple assignment, so this replaces
 * the whole property (restored to `localhost` in `afterEach` below) rather
 * than navigating, which jsdom refuses across origins.
 */
function setHostname(hostname: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, hostname, href: `http://${hostname}/` },
  });
}

afterEach(() => {
  runExport.mockClear();
  delete (window as unknown as E2EWindow).__aksharoE2E;
  setHostname("localhost");
});

describe("useExportDialog — preferFileSystemAccess (A07b)", () => {
  it("defaults to true — a real click may reach for the native save picker", async () => {
    await runStartExport(deps());
    expect(runExport).toHaveBeenCalledTimes(1);
    expect(runExport.mock.calls[0]?.[0]).toMatchObject({ preferFileSystemAccess: true });
  });

  it("honours an explicit false from the caller", async () => {
    await runStartExport(deps({ preferFileSystemAccess: false }));
    expect(runExport.mock.calls[0]?.[0]).toMatchObject({ preferFileSystemAccess: false });
  });

  it("a window.__aksharoE2E.noFilePicker flag on a loopback origin forces false", async () => {
    setE2EFlag(true);
    await runStartExport(deps());
    expect(runExport.mock.calls[0]?.[0]).toMatchObject({ preferFileSystemAccess: false });
  });

  it("the E2E flag wins even over an explicit true from the caller", async () => {
    setE2EFlag(true);
    await runStartExport(deps({ preferFileSystemAccess: true }));
    expect(runExport.mock.calls[0]?.[0]).toMatchObject({ preferFileSystemAccess: false });
  });

  it("never applies on a real (non-loopback) origin, flag or not", async () => {
    setHostname("app.aksharo.example");
    setE2EFlag(true);
    await runStartExport(deps());
    expect(runExport.mock.calls[0]?.[0]).toMatchObject({ preferFileSystemAccess: true });
  });
});
