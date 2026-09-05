"use client";

/**
 * The dialog's state machine: probe once on open, request a manifest per
 * preset choice, run the engine (worker) or hand the user to the cloud path,
 * and call `POST /exports/manifests/{id}/complete` when the engine finishes.
 *
 * Deliberately not a `react-query` mutation: the export has its own
 * long-lived progress stream (`onProgress`) and a cancellation button, which
 * fit a small hand-rolled reducer better than a request/response cache entry.
 */

import * as React from "react";

import { defineEndpoint, endpoints, useApiClient } from "@montaj/api-client";
import type { ApiClient, JobStatus, JobSummary } from "@montaj/api-client";
import type { StyleDoc } from "@montaj/caption-styles";
import type { EdgProjection, FontRegistry, Shaper } from "@montaj/render-core";
import type { RenderManifest } from "@montaj/render-manifest";

import {
  completeExportManifest,
  decideAudioStrategy,
  isBrowserExportEligible,
  outputDurationMsFor,
  probeExportCapabilities,
  requestExportManifest,
  sanityCheckManifest,
  toCapabilitiesRequest,
  type CreateExportRequest,
  type CreateExportResponse,
  type EngineProgress,
  type EngineResult,
  type ExportCapabilityProbe,
} from "@/lib/export";
import { runExport } from "@/lib/export/engine";

export interface ExportDialogDeps {
  readonly projectId: string;
  readonly projection: EdgProjection;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry | undefined;
  readonly shaper: Shaper | undefined;
  /**
   * Passed straight through to `runExport` (`lib/export/engine.ts`'s
   * `RunExportOptions`). Defaults to `true` — a real user click is a trusted
   * gesture, so `createExportTarget` reaches for `showSaveFilePicker` before
   * falling back to a plain download. A caller only ever sets this to drive
   * the engine at a specific target in a unit test; production callers should
   * leave it unset and let the E2E override below (a synthetic Playwright
   * click is never a trusted gesture, so `showSaveFilePicker` throws
   * `NotAllowedError` and the whole export aborts) do its job instead.
   */
  readonly preferFileSystemAccess?: boolean;
}

/**
 * `window.__aksharoE2E` — an escape hatch that lets `apps/web/e2e/export.
 * spec.ts` click all the way through the export dialog, never armed for a
 * real user.
 *
 * A synthetic click is not a "user activation" as far as `showSaveFilePicker`
 * is concerned, so without this flag the dialog's real button is
 * un-automatable: the picker call rejects with `NotAllowedError` and the
 * export ends in `phase: "error"` before a single frame renders. Setting
 * `noFilePicker: true` (`export.spec.ts`'s `page.addInitScript`, before the
 * app's own scripts run) is Playwright's side of the handshake.
 *
 * **Why this does not gate on `process.env.NODE_ENV`.** The brief's original
 * ask was "non-production builds only", the obvious-looking check — but
 * `playwright.config.ts`'s web project runs `next build && next start` on
 * purpose (`10-build-plan.md`'s "what the review screenshots should show"),
 * and Next.js inlines `process.env.NODE_ENV` as the literal string
 * `"production"` in every client bundle it builds, watch mode or not
 * (webpack's `DefinePlugin`, unconditionally, not only for `NEXT_PUBLIC_*`
 * vars). A `NODE_ENV` check here would therefore read `"production"` in
 * exactly the one build this flag needs to work in, and never fire — a
 * literal reading of the brief that cannot pass its own acceptance
 * criterion. The loopback-origin check below is the property `NODE_ENV` was
 * standing in for ("never armed for a paying user's own domain") and, unlike
 * `NODE_ENV`, it is a real runtime check the build cannot inline away.
 */
interface AksharoE2EWindow {
  readonly __aksharoE2E?: { readonly noFilePicker?: boolean };
}

/** `true` only on a loopback origin (this suite's own `127.0.0.1`/`localhost`) that opted in. */
function e2eNoFilePicker(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname } = window.location;
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return false;
  return (window as unknown as AksharoE2EWindow).__aksharoE2E?.noFilePicker === true;
}

export type ExportPhase =
  | "idle"
  | "probing"
  | "requesting"
  | "cloud-offered"
  | "cloud-rendering"
  | "cloud-done"
  | "rendering"
  | "completing"
  | "done"
  | "error"
  | "cancelled";

/**
 * The cloud render this dialog is following, as `GET /jobs/{id}` reports it
 * (`apps/api/src/jobs/jobs.dto.ts`'s `JobDto`).
 */
export interface CloudJobView {
  readonly jobId: string;
  readonly status: JobStatus;
  /** 0-100. `null` only before the first poll has answered. */
  readonly progress: number | null;
}

export interface ExportDialogState {
  readonly phase: ExportPhase;
  readonly probe: ExportCapabilityProbe | null;
  readonly response: CreateExportResponse | null;
  readonly manifest: RenderManifest | null;
  readonly progress: EngineProgress | null;
  readonly result: EngineResult | null;
  readonly error: string | null;
  /** The followed cloud render (`cloud-rendering` / `cloud-done`). */
  readonly cloudJob: CloudJobView | null;
  /** Resolved once the cloud render succeeds; `null` when no link came back. */
  readonly downloadUrl: string | null;
}

const INITIAL_STATE: ExportDialogState = {
  phase: "idle",
  probe: null,
  response: null,
  manifest: null,
  progress: null,
  result: null,
  error: null,
  cloudJob: null,
  downloadUrl: null,
};

/**
 * `GET /exports/{exportId}/download` (F06 step 3, Case A).
 *
 * The route already existed at this package's base - `exports.controller.ts`'s
 * `@Get("exports/:exportId/download")` (line 183) over `exports.service.ts`'s
 * `downloadUrl(exportId, workspaceId)` (line 546), which presigns the output
 * key and increments the export's `downloads` counter. Nothing was added
 * server-side; `operationId` is the generated index's own id, so the compiler
 * fails here if that route ever moves.
 *
 * It is declared locally rather than in `packages/api-client/src/endpoints.ts`
 * for the same reason `apps/web/lib/export/endpoints.ts` declares the other
 * export routes locally - see that file's header. The two job routes this hook
 * needs (`GET /jobs/{id}`, `POST /jobs/{id}/cancel`) do already live in the
 * shared, contract-tested descriptors, so those are imported, not redeclared.
 */
const exportDownloadEndpoint = defineEndpoint<void, { url: string; expiresAt: string }>({
  method: "GET",
  path: "/exports/{exportId}/download",
  auth: "bearer",
  operationId: "getExportDownloadUrl",
});

/**
 * Has `cancel()` been pressed?
 *
 * Read through the ref on every call, and deliberately a function rather than
 * an inline expression: `abort()` mutates the signal from outside this control
 * flow, which TypeScript cannot see — an inline second check gets narrowed away
 * as unreachable.
 */
function isAborted(ref: React.RefObject<AbortController | null>): boolean {
  return ref.current?.signal.aborted === true;
}

/** Poll backoff for a cloud render: gentle at first, then settled at 5 s. */
const POLL_DELAYS_MS = [2_000, 3_000, 5_000] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(() => resolve(), ms));

/**
 * The download link for a finished cloud render.
 *
 * Returns `null` instead of throwing: the file rendered either way, and a
 * missing link is worth saying honestly (the dialog points at the project's
 * exports) rather than turning a successful render into an error panel.
 */
async function resolveDownloadUrl(
  client: ApiClient,
  response: CreateExportResponse,
): Promise<string | null> {
  try {
    const { url } = await client.call(exportDownloadEndpoint, {
      params: { exportId: response.exportId },
    });
    return url;
  } catch {
    return null;
  }
}

/** Fetches the watermark PNG bytes from A21b's presigned `sources.watermarkUrl`. */
async function fetchWatermarkBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`could not fetch the watermark asset: ${String(response.status)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function useExportDialog(deps: ExportDialogDeps): {
  readonly state: ExportDialogState;
  readonly startExport: (request: CreateExportRequest) => Promise<void>;
  readonly cancel: () => void;
  readonly reset: () => void;
} {
  const client = useApiClient();
  const [state, setState] = React.useState<ExportDialogState>(INITIAL_STATE);
  // `cancel` must read the CURRENT phase and job without being re-created on
  // every state change (it is handed to a button that would otherwise remount).
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const controllerRef = React.useRef<AbortController | null>(null);
  const inFlightRef = React.useRef(false);

  const reset = React.useCallback(() => setState(INITIAL_STATE), []);

  const cancel = React.useCallback(() => {
    // Closes the browser engine's render AND the cloud follower's loop.
    controllerRef.current?.abort();
    const jobId = stateRef.current.cloudJob?.jobId;
    // A cloud render is server-owned: aborting the poll only stops watching it,
    // so the job itself has to be told, or it renders (and bills) to the end.
    if (jobId !== undefined && stateRef.current.phase === "cloud-rendering") {
      // The browser path reaches `cancelled` through the engine's own
      // `ExportCancelledError`; a followed cloud job has no such throw, so the
      // phase is set here or the dialog sits on "Rendering in the cloud…"
      // forever after the reader has already asked it to stop.
      setState((s) => ({ ...s, phase: "cancelled" }));
      void client.call(endpoints.jobs.cancel, { params: { id: jobId } }).catch(() => undefined);
    }
  }, [client]);

  /**
   * Follow a server-side render to its end.
   *
   * A poll, not a room event: `job.completed` carries no `projectId` (F03's
   * discovery), and this dialog only ever watches one job it already has the
   * id of. Bounded by concurrently-watching users - the guide's scale note
   * marks this loop as the one place a push subscription swaps in.
   */
  const followCloudJob = React.useCallback(
    async (jobId: string, response: CreateExportResponse): Promise<void> => {
      for (let attempt = 0; ; attempt += 1) {
        if (isAborted(controllerRef)) return; // cancel() closes the loop
        const delay = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 5_000;
        let job: JobSummary;
        try {
          job = await client.call(endpoints.jobs.get, { params: { id: jobId } });
          // A cancel that lands while this poll is in flight must win: without
          // this, a render that succeeded in the same instant would overwrite
          // `cancelled` with a Download button the reader never asked for.
          if (isAborted(controllerRef)) return;
        } catch {
          // A transient poll failure is not a failed render - the job is
          // server-side and unaffected by it. Keep following.
          await sleep(delay);
          continue;
        }
        setState((s) => ({
          ...s,
          cloudJob: { jobId, status: job.status, progress: job.progress },
        }));
        if (job.status === "succeeded") {
          const url = await resolveDownloadUrl(client, response);
          setState((s) => ({ ...s, phase: "cloud-done", downloadUrl: url }));
          return;
        }
        if (job.status === "failed" || job.status === "cancelled") {
          setState((s) => ({
            ...s,
            phase: job.status === "cancelled" ? "cancelled" : "error",
            error: job.error?.message ?? "The cloud render failed.",
          }));
          return;
        }
        await sleep(delay);
      }
    },
    [client],
  );

  const startExport = React.useCallback(
    async (request: CreateExportRequest): Promise<void> => {
      // Re-entrancy guard: a second call while one export is in flight is always
      // a bug upstream (double-click, an effect misfiring) — refuse it instead
      // of double-spending credits.
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        // A previous run's job and download link must not survive into this
        // one - a stale Download button points at the wrong file.
        setState((s) => ({
          ...s,
          phase: "probing",
          error: null,
          cloudJob: null,
          downloadUrl: null,
        }));
        const probe = await probeExportCapabilities({
          width: request.customWidth,
          height: request.customHeight,
        });
        setState((s) => ({ ...s, probe, phase: "requesting" }));

        const eligible = isBrowserExportEligible(probe);
        const capabilities = toCapabilitiesRequest(probe);

        const { response, manifest } = await requestExportManifest(client, deps.projectId, {
          ...request,
          mode: request.mode ?? (eligible ? "auto" : "cloud"),
          capabilities,
        });
        setState((s) => ({ ...s, response, manifest }));

        if (manifest === null) {
          // Cloud path (or subtitle-only, or an ineligible browser — A21b's
          // decision.ts now itself refuses "auto" for a browser lacking H.264
          // decode+encode or a usable audio path, and for an HDR source):
          // nothing more for the engine to do. The dialog shows
          // `response.reasons` and, for a cloud video export, `response.job`.
          const job = response.job;
          if (job !== undefined) {
            // The server already enqueued the render when it refused the browser
            // path - the old code showed a dead-end panel here while the file
            // rendered unobserved (audit: four finished MP4s, downloads = 0).
            controllerRef.current = new AbortController();
            setState((s) => ({
              ...s,
              phase: "cloud-rendering",
              cloudJob: { jobId: job.jobId, status: "queued", progress: null },
            }));
            await followCloudJob(job.jobId, response);
            return;
          }
          setState((s) => ({ ...s, phase: "cloud-offered" }));
          return;
        }

        const outputDurationMs = outputDurationMsFor(manifest);
        const sanity = sanityCheckManifest(manifest, outputDurationMs);
        if (!sanity.ok) {
          setState((s) => ({
            ...s,
            phase: "error",
            error: sanity.expired
              ? "This export link expired before rendering started — try again."
              : sanity.notYetValid
                ? "This export link is not valid yet (clock skew) — try again."
                : `This render exceeds the workspace's plan: ${sanity.capViolations
                    .map((v) => v.cap)
                    .join(", ")}.`,
          }));
          return;
        }

        if (deps.registry === undefined || deps.shaper === undefined) {
          setState((s) => ({
            ...s,
            phase: "error",
            error: "The renderer has not finished loading yet.",
          }));
          return;
        }

        if (response.sources === undefined) {
          setState((s) => ({
            ...s,
            phase: "error",
            error: "The API did not return source URLs for this browser export (A21b `sources`).",
          }));
          return;
        }
        const sources = response.sources;

        const audioDecision = decideAudioStrategy({
          manifest,
          aacEncodable: probe.audio.aac,
          aacPolyfillAvailable: true,
        });
        if (audioDecision.kind === "cloud-required") {
          // The browser can render video but not this audio path: re-request as
          // an explicit cloud export ONCE and follow that job, instead of
          // dead-ending. No double spend - the browser attempt enqueued no
          // server job at all, and this fresh manifest is the only one the
          // server has keyed a render to.
          const cloud = await requestExportManifest(client, deps.projectId, {
            ...request,
            mode: "cloud",
            capabilities,
          });
          const cloudJob = cloud.response.job;
          if (cloudJob !== undefined) {
            controllerRef.current = new AbortController();
            setState((s) => ({
              ...s,
              response: cloud.response,
              phase: "cloud-rendering",
              error: audioDecision.reason,
              cloudJob: { jobId: cloudJob.jobId, status: "queued", progress: null },
            }));
            await followCloudJob(cloudJob.jobId, cloud.response);
            return;
          }
          setState((s) => ({ ...s, phase: "cloud-offered", error: audioDecision.reason }));
          return;
        }

        const controller = new AbortController();
        setState((s) => ({ ...s, phase: "rendering" }));
        controllerRef.current = controller;

        try {
          // A21b's `rawUrl` is the ORIGINAL media (S3) — a 540p proxy cannot
          // produce a clean ≥1080p export, so the engine always decodes it,
          // falling back to `proxyUrl` only if `rawUrl` is somehow absent.
          const sourceUrl = sources.rawUrl ?? sources.proxyUrl;
          if (sourceUrl === undefined) {
            throw new Error("no source URL was returned for this export");
          }
          const watermarkUrl = sources.watermarkUrl;
          // B10: present whenever the manifest asked for the cleaned track
          // (`audio.strategy === "replace"`); the engine refuses to proceed on
          // "replace" without it.
          const cleanAudioSource = sources.cleanedAudioUrl;
          // An E2E run's flag wins over whatever the caller passed: a synthetic
          // click can never satisfy `showSaveFilePicker`'s activation check, so
          // there is no scenario where automation wants the picker anyway.
          const preferFileSystemAccess = e2eNoFilePicker()
            ? false
            : (deps.preferFileSystemAccess ?? true);
          const result = await runExport({
            manifest,
            source: sourceUrl,
            ...(cleanAudioSource === undefined ? {} : { cleanAudioSource }),
            projection: deps.projection,
            catalogue: deps.catalogue,
            registry: deps.registry,
            shaper: deps.shaper,
            signal: controller.signal,
            preferFileSystemAccess,
            aacEncodable: probe.audio.aac,
            aacPolyfillAvailable: true,
            fetchWatermarkAsset:
              watermarkUrl === undefined ? undefined : () => fetchWatermarkBytes(watermarkUrl),
            onProgress: (progress) => setState((s) => ({ ...s, progress })),
          });
          setState((s) => ({ ...s, phase: "completing", result }));
          await completeExportManifest(client, manifest.manifestId, {
            sizeBytes: result.sizeBytes,
            durationMs: result.durationMs,
            checksum: result.checksum,
          });
          setState((s) => ({ ...s, phase: "done" }));
        } catch (error) {
          if (error instanceof Error && error.name === "ExportCancelledError") {
            setState((s) => ({ ...s, phase: "cancelled" }));
            return;
          }
          setState((s) => ({
            ...s,
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [client, deps, followCloudJob],
  );

  return { state, startExport, cancel, reset };
}
