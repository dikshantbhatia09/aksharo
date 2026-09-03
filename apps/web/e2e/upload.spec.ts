import { signUpAndSkipOnboarding } from "./auth-helpers";
import { API_ORIGIN, expect, expectNoSeriousA11yViolations, gotoHydrated, test } from "./fixtures";
import { generateWavFile } from "./fixtures-media";
import { completeJobForTest } from "./internal-callback";

import type { Page } from "@playwright/test";

/**
 * The upload engine, end to end (07 F-101; brief acceptance criteria 1–2).
 * `lib/upload/*.test.ts` already proves chunking, retry, pause/resume and
 * resuming a `fake-indexeddb` record after a simulated reload with a
 * synthetic 40 MB payload — this suite is the one place that proves the same
 * engine moves real bytes to the real MinIO behind `S3_ENDPOINT` through a
 * real presigned URL, for a small real file, in a real browser.
 */

async function dropFile(page: Page, path: string): Promise<void> {
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /drop videos or audio here/i }).click();
  const chooser = await fileChooserPromise;
  await chooser.setFiles(path);
}

/**
 * The access token the page itself is holding, read the way the browser
 * would refresh it: `POST /api/session/refresh` reads the httpOnly cookie
 * Playwright's browser context already carries and hands back a fresh
 * 15-minute token (CONTRACTS §5). Run inside the page (`page.evaluate`) so
 * the request is genuinely same-origin — the route refuses a cross-site
 * caller.
 */
async function currentAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const response = await fetch("/api/session/refresh", { method: "POST" });
    const body = (await response.json()) as { accessToken?: string };
    return body.accessToken ?? null;
  });
  // eslint-disable-next-line security/detect-possible-timing-attacks -- sentinel comparison (null/undefined/boolean/empty-string), not a secret/MAC comparison -- reviewed for the same follow-up
  if (token === null) throw new Error("could not obtain an access token from the page's session");
  return token;
}

test("uploading a small real clip creates a project and completes the multipart upload against MinIO", async ({
  page,
}) => {
  await signUpAndSkipOnboarding(page, "upload");

  const clipPath = generateWavFile({ filename: "hinglish-clip.wav", seconds: 3 });
  await dropFile(page, clipPath);

  await expect(page.getByTestId("upload-tray-item")).toBeVisible();
  await expect(page.getByTestId("upload-tray-item")).toContainText("hinglish-clip.wav");

  // The upload settles (uploaded, `media.probe` enqueued, `complete` called)
  // without a live worker: `client/not_implemented` from the not-yet-merged
  // A11 `/transcribe` route is treated as "uploaded, not transcribing yet",
  // not a failure — see `upload-job.ts`. Real network to MinIO, so this gets
  // real time rather than the suite's default expect timeout.
  await expect(page.getByTestId("job-progress")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.getByTestId("upload-cancel").count(), { timeout: 30_000 })
    .toBe(0); // "Cancel" only shows while still in flight; gone once settled.

  // The project is real and shows up in the Recent grid.
  await gotoHydrated(page, "/projects");
  await expect(page.getByTestId("project-card").first()).toContainText("hinglish clip");
});

test("a duplicate upload (same content hash) is detected and not re-uploaded", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "dup");
  const clipPath = generateWavFile({ filename: "same-clip.wav", seconds: 2 });

  await dropFile(page, clipPath);
  await expect
    .poll(async () => page.getByTestId("upload-cancel").count(), { timeout: 30_000 })
    .toBe(0);
  await page.getByTestId("upload-dismiss").click();

  await dropFile(page, clipPath);
  await expect(page.getByText("Already in your workspace.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("duplicate-open-original")).toBeVisible();
});

/**
 * Proves the project card's status is genuinely realtime-driven, not only
 * polling: `AppShell` subscribes to the workspace's realtime room and
 * invalidates every `["ws", id, "jobs", ...]` query on `job.progress` /
 * `job.completed`; `useProjectJobs`'s key nests under exactly that prefix
 * (`query-keys.ts`). Completing the probe job through the signed internal
 * callback — the same call `apps/worker-media` makes — is the "API-side test
 * hook" the brief allows in place of running a real worker.
 */
test("a project card's status updates when its job completes through the internal callback", async ({
  page,
}) => {
  await signUpAndSkipOnboarding(page, "livejob");

  await page.getByTestId("try-with-sample").click();
  // See `home.spec.ts`'s note on this timeout: the first real S3 PUT in a
  // run can pay a one-time connection warm-up cost.
  await page.waitForURL(/\/p\//, { timeout: 60_000 });
  const projectId = new URL(page.url()).pathname.split("/").pop();
  expect(projectId).toMatch(/^[0-9A-Z]{26}$/);

  await gotoHydrated(page, "/projects");
  const card = page.getByTestId("project-card").first();
  await expect(card).toBeVisible();

  const token = await currentAccessToken(page);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const jobsResponse = await page.request.get(`${API_ORIGIN}/jobs`, {
    headers: authHeaders,
    params: { projectId: projectId ?? "", status: "queued" },
  });
  expect(jobsResponse.ok()).toBe(true);
  const jobs = (await jobsResponse.json()) as {
    items: { id: string; type: string; attemptId: string | null }[];
  };
  const probeJob = jobs.items.find((job) => job.type === "media.probe");
  expect(probeJob).toBeDefined();
  // A job carries its `attemptId` from the moment it is enqueued (CONTRACTS
  // §3), not only once a worker picks it up — a mismatched one is answered
  // `{applied: false, reason: "stale_attempt"}` rather than an error, so it
  // has to be the job's own.
  expect(probeJob?.attemptId).toBeTruthy();

  const mediaResponse = await page.request.get(`${API_ORIGIN}/projects/${projectId}/media`, {
    headers: authHeaders,
  });
  expect(mediaResponse.ok()).toBe(true);
  const media = (await mediaResponse.json()) as { id: string }[];
  expect(media.length).toBeGreaterThan(0);

  // `MediaProbeCompletionHandler` parses `result` as a `ProbeResult`
  // (`probe-result.ts`) and throws — answering the callback 5xx — on
  // anything that does not match; this is the shape the real
  // `apps/worker-media` reports.
  await completeJobForTest(probeJob!.id, probeJob!.attemptId!, {
    status: "succeeded",
    result: {
      mediaId: media[0]!.id,
      container: "wav",
      mime: "audio/wav",
      durationMs: 3_000,
      sizeBytes: 48_044,
      hasVideo: false,
      hasAudio: true,
      video: null,
      audio: { codec: "pcm_s16le", sampleRate: 8_000, channels: 1 },
      probedAt: new Date().toISOString(),
      toolVersion: "e2e-test-hook",
    },
  });

  // The card is honest about what is still outstanding: completing the probe
  // enqueues `media.proxy` as its child (`MediaProbeCompletionHandler`), so
  // the project is not "ready" yet — it is still processing, now under a
  // different job. Confirming that transition first is itself proof the
  // status is live, not stuck.
  await expect(card).toHaveAttribute("data-status", "queued", { timeout: 15_000 });

  const proxyJobsResponse = await page.request.get(`${API_ORIGIN}/jobs`, {
    headers: authHeaders,
    params: { projectId: projectId ?? "", type: "media.proxy" },
  });
  expect(proxyJobsResponse.ok()).toBe(true);
  const proxyJobs = (await proxyJobsResponse.json()) as {
    items: { id: string; attemptId: string | null }[];
  };
  expect(proxyJobs.items.length).toBeGreaterThan(0);
  const proxyJob = proxyJobs.items[0]!;
  expect(proxyJob.attemptId).toBeTruthy();

  await completeJobForTest(proxyJob.id, proxyJob.attemptId!, {
    status: "succeeded",
    result: {},
  });

  await expect(card).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
});

test("the upload flow is axe-clean while a file is in flight", async ({ page }) => {
  await signUpAndSkipOnboarding(page, "uploadaxe");
  const clipPath = generateWavFile({ filename: "axe-clip.wav", seconds: 2 });
  await dropFile(page, clipPath);
  await expect(page.getByTestId("upload-tray-item")).toBeVisible();
  await expectNoSeriousA11yViolations(page, "Home (upload in progress)");
});
